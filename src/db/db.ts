import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { nwc } from "npm:@getalby/sdk";
import postgres from "npm:postgres@3.4.5";

import { and, eq, isNull } from "drizzle-orm";
import { DATABASE_URL } from "../constants.ts";
import {
  assertRebindNostr,
  consumeRebindTokenCount,
  hashRebindToken,
  newRebindToken,
} from "../spark/rebind.ts";
import { routeCreateUser } from "../spark/destination.ts";
import { decrypt, encrypt } from "./aesgcm.ts";
import * as schema from "./schema.ts";
import { invoices, rebindTokens, users } from "./schema.ts";
import { buildSparkUserValues, parseNwcConnectionSecret } from "./userValues.ts";

export async function runMigration() {
  const migrationClient = postgres(DATABASE_URL, { max: 1 });
  await migrate(drizzle(migrationClient), {
    migrationsFolder: "./drizzle",
  });
}

export class DB {
  private _db: PostgresJsDatabase<typeof schema>;

  constructor() {
    const queryClient = postgres(DATABASE_URL);
    this._db = drizzle(queryClient, {
      schema,
    });
  }

  async createUser(
    connectionSecret: string,
    username?: string,
    nostrPubkey?: string
  ) {
    parseNwcConnectionSecret(connectionSecret);
    // TODO: use haikunator    
    username = username || Math.floor(Math.random() * 100000000000).toString();
    
    const safeNostrPubkey = nostrPubkey || "";
    
    const encryptedConnectionSecret = await encrypt(connectionSecret);
    
    const [newUser] = await this._db.insert(users).values({
      encryptedConnectionSecret,
      username,
      nostrPubkey: safeNostrPubkey
    }).returning({ id: users.id, username: users.username, nostrPubkey: users.nostrPubkey });
    
    return newUser;
  }

  async createSparkUser(
    sparkIdentityPubkey: string,
    username?: string,
    nostrPubkey?: string
  ) {
    const values = buildSparkUserValues({
      sparkIdentityPubkey,
      username,
      nostrPubkey,
    });
    const [newUser] = await this._db.insert(users).values(values).returning({
      id: users.id,
      username: users.username,
      nostrPubkey: users.nostrPubkey,
    });
    return newUser;
  }

  getAllUsers() {
    return this._db.query.users.findMany();
  }

  async findUser(username: string) {
    const result = await this._db.query.users.findFirst({
      where: eq(users.username, username),
    });
    if (!result) {
      throw new Error("user not found");
    }
    const connectionSecret = result.encryptedConnectionSecret
      ? await decrypt(result.encryptedConnectionSecret)
      : null;
    return {
      id: result.id,
      username: result.username,
      nostrPubkey: result.nostrPubkey,
      connectionSecret,
      destination: result.destination,
      sparkIdentityPubkey: result.sparkIdentityPubkey,
    };
  }

  async createInvoice(
    userId: number,
    transaction: nwc.Nip47Transaction
  ) {
    await this._db.insert(invoices).values({
      userId,
      amount: transaction.amount,
      description: transaction.description,
      paymentRequest: transaction.invoice,
      paymentHash: transaction.payment_hash,
      metadata: transaction.metadata,
    });

    return;
  }

  async findInvoice(paymentHash: string) {
    const result = await this._db.query.invoices.findFirst({
      where: eq(invoices.paymentHash, paymentHash),
    });
    if (!result) {
      throw new Error("invoice not found");
    }
    return result;
  }

  async markInvoiceSettled(
    userId: number,
    transaction: nwc.Nip47Transaction
  ): Promise<void> {
    await this._db
      .update(invoices)
      .set({
        preimage: transaction.preimage,
        settledAt: new Date(transaction.settled_at * 1000),
      })
      .where(
        and(
          eq(invoices.userId, userId),
          eq(invoices.paymentHash, transaction.payment_hash)
        )
      )

    return;
  }

  async markInvoiceSettledByPaymentHash(
    paymentHash: string,
    preimage: string,
    settledAt: Date = new Date(),
  ): Promise<void> {
    await this._db
      .update(invoices)
      .set({
        preimage,
        settledAt,
      })
      .where(eq(invoices.paymentHash, paymentHash));
  }

  async issueRebindToken(username: string): Promise<string> {
    await this.findUser(username);
    const token = newRebindToken();
    await this._db.insert(rebindTokens).values({
      username,
      tokenHash: hashRebindToken(token),
    });
    return token;
  }

  async rebindUser(input: {
    username: string;
    nostrPubkey: string;
    rebindToken: string;
    sparkIdentityPubkey?: string;
    connectionSecret?: string;
  }): Promise<
    | { userId: number; kind: "spark" }
    | { userId: number; kind: "nwc"; connectionSecret: string }
  > {
    const route = routeCreateUser(input);
    if (route.kind === "error") {
      throw new Error(route.reason);
    }

    const tokenHash = hashRebindToken(input.rebindToken);

    return await this._db.transaction(async (tx) => {
      const consumed = await tx.update(rebindTokens).set({ usedAt: new Date() }).where(
        and(
          eq(rebindTokens.tokenHash, tokenHash),
          eq(rebindTokens.username, input.username),
          isNull(rebindTokens.usedAt),
        ),
      ).returning();
      consumeRebindTokenCount(consumed.length);

      const user = await tx.query.users.findFirst({
        where: eq(users.username, input.username),
      });
      if (!user) {
        throw new Error("user not found");
      }
      assertRebindNostr(user.nostrPubkey, input.nostrPubkey);

      if (route.kind === "spark") {
        await tx.update(users).set({
          destination: "spark",
          sparkIdentityPubkey: route.sparkIdentityPubkey,
          encryptedConnectionSecret: null,
        }).where(eq(users.id, user.id));
        return { userId: user.id, kind: "spark" as const };
      }

      parseNwcConnectionSecret(route.connectionSecret);
      const encryptedConnectionSecret = await encrypt(route.connectionSecret);
      await tx.update(users).set({
        destination: null,
        sparkIdentityPubkey: null,
        encryptedConnectionSecret,
      }).where(eq(users.id, user.id));
      return {
        userId: user.id,
        kind: "nwc" as const,
        connectionSecret: route.connectionSecret,
      };
    });
  }
}
