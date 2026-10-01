import { drizzle, PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { nwc } from "npm:@getalby/sdk";
import postgres from "npm:postgres@3.4.5";

import { and, eq, gt, isNull, lt, lte, ne } from "drizzle-orm";
import { DATABASE_URL } from "../constants.ts";
import { decrypt } from "./aesgcm.ts";
import * as schema from "./schema.ts";
import { bindingIntents, invoices, signedStatements, users } from "./schema.ts";

export const DESTINATION = { NWC: "nwc", SPARK: "spark" } as const;
export type Destination = (typeof DESTINATION)[keyof typeof DESTINATION];

/** Single precedence for intent creation and register (intent rows 1 to 4, register rows 1 to 3). */
export const CONFLICT = {
  NAME_TAKEN: "name_taken",
  ACCOUNT_USERNAME_DIFFERS: "account_username_differs",
  PUBKEY_TAKEN: "pubkey_taken",
  NAME_IN_PROGRESS: "name_in_progress",
  STATEMENT_USED: "statement_used",
} as const;
export type Conflict = (typeof CONFLICT)[keyof typeof CONFLICT];

export const INTENT_TTL_SECS = 600;

export interface UserRow {
  id: number;
  username: string;
  nostrPubkey: string;
  destination: Destination;
  sparkIdentityPubkey: string | null;
  /** Ciphertext as stored; decrypt only where the plaintext is needed. */
  encryptedConnectionSecret: string | null;
}

type UserRecord = typeof users.$inferSelect;
type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function toUserRow(record: UserRecord): UserRow {
  return {
    id: record.id,
    username: record.username,
    nostrPubkey: record.nostrPubkey,
    destination: record.destination as Destination,
    sparkIdentityPubkey: record.sparkIdentityPubkey,
    encryptedConnectionSecret: record.encryptedConnectionSecret,
  };
}

export type CreateUserResult =
  | { kind: "created"; user: UserRow }
  | { kind: "conflict"; reason: "username_taken" | "account_exists" | "name_in_progress" };

/** Single-use claim on a signed register statement. `expiresAt` is (ts + VALIDITY_SECS) seconds. */
export interface StatementClaim {
  hash: string;
  route: "register";
  expiresAt: Date;
}

export type RegisterResult =
  | {
    kind: "created" | "switched" | "rotated" | "unchanged";
    user: UserRow;
    previous: Destination | null;
  }
  | { kind: "no_intent" }
  | { kind: "conflict"; reason: Exclude<Conflict, "name_in_progress"> };

/** Thrown inside a transaction to roll it back and hand a result to the caller. */
class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super("rollback");
  }
}

export type BindingIntentResult =
  | { kind: "ok"; expiresAt: Date }
  | { kind: "conflict"; reason: Exclude<Conflict, "statement_used"> };

export async function runMigration() {
  const migrationClient = postgres(DATABASE_URL, { max: 1 });
  await migrate(drizzle(migrationClient), {
    migrationsFolder: "./drizzle",
  });
}

export class DB {
  private _db: Database;
  private readonly _client: ReturnType<typeof postgres>;

  constructor(databaseUrl: string = DATABASE_URL) {
    this._client = postgres(databaseUrl);
    this._db = drizzle(this._client, {
      schema,
    });
  }

  async close(): Promise<void> {
    await this._client.end({ timeout: 5 });
  }

  async findUserByNostrPubkey(npubHex: string): Promise<UserRow | null> {
    return await selectUserBy(this._db, eq(users.nostrPubkey, npubHex));
  }

  async findUserBySparkPubkey(pubkey: string): Promise<UserRow | null> {
    return await selectUserBy(this._db, eq(users.sparkIdentityPubkey, pubkey));
  }

  async findUserByUsername(username: string): Promise<UserRow | null> {
    return await selectUserBy(this._db, eq(users.username, username));
  }

  /** The intent for `username` whose `expires_at` is strictly after `now`, if any. */
  async findActiveBindingIntent(
    username: string,
    now: Date,
  ): Promise<{ nostrPubkey: string; sparkPubkey: string } | null> {
    const [intent] = await this._db
      .select({ nostrPubkey: bindingIntents.nostrPubkey, sparkPubkey: bindingIntents.sparkPubkey })
      .from(bindingIntents)
      .where(and(eq(bindingIntents.username, username), gt(bindingIntents.expiresAt, now)))
      .limit(1);
    return intent ?? null;
  }

  /**
   * One transaction: prune expired intents, evaluate conflict rows 1 to 3 in
   * order, upsert the intent (row 4 is the upsert refusing a foreign active
   * intent), then drop the account's intents for other usernames.
   */
  async createBindingIntent(input: {
    npubHex: string;
    username: string;
    sparkPubkey: string;
    now: Date;
  }): Promise<BindingIntentResult> {
    const { npubHex, username, sparkPubkey, now } = input;
    return await this._db.transaction(async (tx) => {
      await tx.delete(bindingIntents).where(lte(bindingIntents.expiresAt, now));

      const conflict = await firstAccountConflict(tx, { npubHex, username, sparkPubkey });
      if (conflict) return { kind: "conflict", reason: conflict } as const;

      const expiresAt = new Date(now.getTime() + INTENT_TTL_SECS * 1000);
      const upserted = await tx
        .insert(bindingIntents)
        .values({ username, nostrPubkey: npubHex, sparkPubkey, expiresAt })
        .onConflictDoUpdate({
          target: bindingIntents.username,
          set: { nostrPubkey: npubHex, sparkPubkey, expiresAt },
          setWhere: eq(bindingIntents.nostrPubkey, npubHex),
        })
        .returning({ username: bindingIntents.username });
      if (upserted.length === 0) {
        return { kind: "conflict", reason: CONFLICT.NAME_IN_PROGRESS } as const;
      }

      await tx
        .delete(bindingIntents)
        .where(and(eq(bindingIntents.nostrPubkey, npubHex), ne(bindingIntents.username, username)));
      return { kind: "ok", expiresAt } as const;
    });
  }

  /**
   * The only way a Spark key is bound. One transaction, in this order: lock the
   * active intent for the username (it must name this key), claim the signed
   * statement, lock the account, username, and key rows and apply the row
   * table, consume the intent. Every non-ok result rolls everything back, so a
   * refused request burns neither the statement nor the intent.
   */
  async registerSparkAddress(input: {
    username: string;
    sparkPubkey: string;
    statement: StatementClaim;
    now: Date;
  }): Promise<RegisterResult> {
    const { username, sparkPubkey, statement, now } = input;
    try {
      return await this._db.transaction(async (tx): Promise<RegisterResult> => {
        const [intent] = await tx
          .select()
          .from(bindingIntents)
          .where(and(eq(bindingIntents.username, username), gt(bindingIntents.expiresAt, now)))
          .for("update");
        if (!intent || intent.sparkPubkey !== sparkPubkey) {
          throw new Rollback<RegisterResult>({ kind: "no_intent" });
        }
        const npub = intent.nostrPubkey;

        const claimed = await tx
          .insert(signedStatements)
          .values({
            statementHash: statement.hash,
            route: statement.route,
            expiresAt: statement.expiresAt,
          })
          .onConflictDoNothing()
          .returning({ hash: signedStatements.statementHash });
        if (claimed.length === 0) {
          throw new Rollback<RegisterResult>({ kind: "conflict", reason: CONFLICT.STATEMENT_USED });
        }
        await tx.delete(signedStatements).where(lt(signedStatements.expiresAt, now));

        // Fixed lock order: account, username, key.
        const lockUser = async (where: ReturnType<typeof eq>) => {
          const [record] = await tx.select().from(users).where(where).limit(1).for("update");
          return record ? toUserRow(record) : null;
        };
        const byAccount = await lockUser(eq(users.nostrPubkey, npub));
        const byName = await lockUser(eq(users.username, username));
        const byKey = await lockUser(eq(users.sparkIdentityPubkey, sparkPubkey));

        const conflict = byName && byName.nostrPubkey !== npub
          ? CONFLICT.NAME_TAKEN
          : byAccount && byAccount.username !== username
          ? CONFLICT.ACCOUNT_USERNAME_DIFFERS
          : byKey && byKey.nostrPubkey !== npub
          ? CONFLICT.PUBKEY_TAKEN
          : null;
        if (conflict) throw new Rollback<RegisterResult>({ kind: "conflict", reason: conflict });

        let outcome: Exclude<RegisterResult, { kind: "no_intent" | "conflict" }>;
        if (!byAccount) {
          const [record] = await tx
            .insert(users)
            .values({
              username,
              nostrPubkey: npub,
              destination: DESTINATION.SPARK,
              sparkIdentityPubkey: sparkPubkey,
              encryptedConnectionSecret: null,
            })
            .returning();
          outcome = { kind: "created", user: toUserRow(record), previous: null };
        } else if (byAccount.destination === DESTINATION.NWC) {
          const [record] = await tx
            .update(users)
            .set({
              destination: DESTINATION.SPARK,
              sparkIdentityPubkey: sparkPubkey,
              encryptedConnectionSecret: null,
            })
            .where(eq(users.id, byAccount.id))
            .returning();
          outcome = { kind: "switched", user: toUserRow(record), previous: DESTINATION.NWC };
        } else if (byAccount.sparkIdentityPubkey === sparkPubkey) {
          outcome = { kind: "unchanged", user: byAccount, previous: DESTINATION.SPARK };
        } else {
          const [record] = await tx
            .update(users)
            .set({ sparkIdentityPubkey: sparkPubkey })
            .where(eq(users.id, byAccount.id))
            .returning();
          outcome = { kind: "rotated", user: toUserRow(record), previous: DESTINATION.SPARK };
        }

        await tx.delete(bindingIntents).where(eq(bindingIntents.username, username));
        return outcome;
      });
    } catch (error) {
      if (error instanceof Rollback) return error.result as RegisterResult;
      const reason = uniqueViolationConflict(error);
      if (reason === "username_taken") return { kind: "conflict", reason: CONFLICT.NAME_TAKEN };
      if (reason === "pubkey_taken") return { kind: "conflict", reason: CONFLICT.PUBKEY_TAKEN };
      throw error;
    }
  }

  /**
   * Creates an NWC-only account row. Conflicts, first match wins: the username
   * is taken, the account already has a row, another account holds an active
   * intent for the username. The intent check shares the transaction with the
   * insert. Concurrent unique violations map to the same conflicts.
   */
  async createUser(input: {
    npubHex: string;
    username: string;
    encryptedSecret: string;
    now: Date;
  }): Promise<CreateUserResult> {
    const npubHex = input.npubHex.toLowerCase();
    const username = input.username.toLowerCase();
    try {
      return await this._db.transaction(async (tx): Promise<CreateUserResult> => {
        if (await selectUserBy(tx, eq(users.username, username))) {
          return { kind: "conflict", reason: "username_taken" };
        }
        if (await selectUserBy(tx, eq(users.nostrPubkey, npubHex))) {
          return { kind: "conflict", reason: "account_exists" };
        }
        if (await hasForeignActiveIntent(tx, { username, npubHex, now: input.now })) {
          return { kind: "conflict", reason: CONFLICT.NAME_IN_PROGRESS };
        }
        const [record] = await tx
          .insert(users)
          .values({
            encryptedConnectionSecret: input.encryptedSecret,
            username,
            nostrPubkey: npubHex,
            destination: DESTINATION.NWC,
          })
          .returning();
        return { kind: "created", user: toUserRow(record) };
      });
    } catch (error) {
      const reason = uniqueViolationConflict(error);
      if (reason === "username_taken" || reason === "account_exists") {
        return { kind: "conflict", reason };
      }
      throw error;
    }
  }

  /**
   * Moves the account's row to NWC in place (same id, username, created_at).
   * The foreign-intent check shares the transaction with the write.
   */
  async bindNwcDestination(
    npubHex: string,
    encryptedSecret: string,
    now: Date,
  ): Promise<
    | { kind: "bound"; user: UserRow }
    | { kind: "not_found" }
    | { kind: "conflict"; reason: "name_in_progress" }
  > {
    const npub = npubHex.toLowerCase();
    return await this._db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(users)
        .where(eq(users.nostrPubkey, npub))
        .limit(1)
        .for("update");
      if (!current) return { kind: "not_found" } as const;
      if (await hasForeignActiveIntent(tx, { username: current.username, npubHex: npub, now })) {
        return { kind: "conflict", reason: CONFLICT.NAME_IN_PROGRESS } as const;
      }
      const [updated] = await tx
        .update(users)
        .set({
          destination: DESTINATION.NWC,
          encryptedConnectionSecret: encryptedSecret,
          sparkIdentityPubkey: null,
        })
        .where(eq(users.id, current.id))
        .returning();
      return { kind: "bound", user: toUserRow(updated) } as const;
    });
  }

  /** Removes the account row (invoices cascade) and its intents. Returns the number of rows removed. */
  async deleteUserByNostrPubkey(npubHex: string): Promise<number> {
    const npub = npubHex.toLowerCase();
    // Legacy rows may hold an empty npub; an empty assertion must never match them.
    if (npub === "") return 0;
    return await this._db.transaction(async (tx) => {
      await tx.delete(bindingIntents).where(eq(bindingIntents.nostrPubkey, npub));
      const removed = await tx
        .delete(users)
        .where(eq(users.nostrPubkey, npub))
        .returning({ id: users.id });
      return removed.length;
    });
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
    transaction: nwc.Nip47Transaction,
    minted: { by: "nwc" } | { by: "spark"; receiverPubkey: string },
  ) {
    await this._db.insert(invoices).values({
      userId,
      amount: transaction.amount,
      description: transaction.description,
      paymentRequest: transaction.invoice,
      paymentHash: transaction.payment_hash,
      metadata: transaction.metadata,
      mintedBy: minted.by,
      receiverPubkey: minted.by === "spark" ? minted.receiverPubkey : null,
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
          eq(invoices.paymentHash, transaction.payment_hash),
          eq(invoices.mintedBy, "nwc"),
          isNull(invoices.preimage),
        )
      )

    return;
  }

  /** The invoice for a payment hash, or null. Unlike `findInvoice` it never hides a database error. */
  async findInvoiceByPaymentHash(paymentHash: string) {
    const [invoice] = await this._db
      .select()
      .from(invoices)
      .where(eq(invoices.paymentHash, paymentHash))
      .limit(1);
    return invoice ?? null;
  }

  /**
   * Write-once settlement of a Spark-minted invoice: one conditional UPDATE
   * that applies only while the preimage is NULL. `settledAt` is Lite's clock.
   */
  async settleSparkInvoice(
    paymentHash: string,
    preimage: string,
    settledAt: Date = new Date(),
  ): Promise<"settled" | "already_settled"> {
    const updated = await this._db
      .update(invoices)
      .set({
        preimage,
        settledAt,
      })
      .where(
        and(
          eq(invoices.paymentHash, paymentHash),
          eq(invoices.mintedBy, "spark"),
          isNull(invoices.preimage),
        )
      )
      .returning({ id: invoices.id });
    return updated.length > 0 ? "settled" : "already_settled";
  }

}

async function selectUserBy(
  executor: Database | Transaction,
  where: ReturnType<typeof eq>,
): Promise<UserRow | null> {
  const [record] = await executor.select().from(users).where(where).limit(1);
  return record ? toUserRow(record) : null;
}

/**
 * Rows 1 to 3 of the shared precedence: the username belongs to another
 * account, the account holds a different username, the Spark key is bound
 * to another account.
 */
async function firstAccountConflict(
  tx: Transaction,
  input: { npubHex: string; username: string; sparkPubkey: string },
): Promise<Exclude<Conflict, "name_in_progress" | "statement_used"> | null> {
  const byName = await selectUserBy(tx, eq(users.username, input.username));
  if (byName && byName.nostrPubkey !== input.npubHex) return CONFLICT.NAME_TAKEN;
  const byAccount = await selectUserBy(tx, eq(users.nostrPubkey, input.npubHex));
  if (byAccount && byAccount.username !== input.username) {
    return CONFLICT.ACCOUNT_USERNAME_DIFFERS;
  }
  const byKey = await selectUserBy(tx, eq(users.sparkIdentityPubkey, input.sparkPubkey));
  if (byKey && byKey.nostrPubkey !== input.npubHex) return CONFLICT.PUBKEY_TAKEN;
  return null;
}

async function hasForeignActiveIntent(
  tx: Transaction,
  input: { username: string; npubHex: string; now: Date },
): Promise<boolean> {
  const [foreign] = await tx
    .select({ username: bindingIntents.username })
    .from(bindingIntents)
    .where(
      and(
        eq(bindingIntents.username, input.username),
        ne(bindingIntents.nostrPubkey, input.npubHex),
        gt(bindingIntents.expiresAt, input.now),
      ),
    )
    .limit(1);
  return foreign !== undefined;
}

/** Maps a Postgres unique violation to the conflict it represents, or null. */
function uniqueViolationConflict(error: unknown): "username_taken" | "account_exists" | "pubkey_taken" | null {
  if (!(error instanceof postgres.PostgresError) || error.code !== "23505") return null;
  switch (error.constraint_name) {
    case "users_username_unique":
      return "username_taken";
    case "users_nostr_pubkey_unique":
      return "account_exists";
    case "users_spark_identity_pubkey_unique":
      return "pubkey_taken";
    default:
      return null;
  }
}
