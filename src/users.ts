import { nip19 } from "@nostr/tools";
import { Hono } from "hono";
import postgres from "postgres";
import { DOMAIN } from "./constants.ts";
import { DB } from "./db/db.ts";
import { logger } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import { routeCreateUser } from "./spark/destination.ts";
import { isValid32ByteHex } from "./utils.ts";

function normalizeNostrPubkey(nostrPubkey: string | undefined): string | null {
  if (!nostrPubkey) return null;
  if (nostrPubkey.startsWith("npub")) {
    return nip19.decode(nostrPubkey).data as string;
  }
  return nostrPubkey;
}

function usernameTakenReason(error: unknown): string | null {
  if (error instanceof postgres.PostgresError && error.constraint_name === "users_username_unique") {
    return "Username has already been taken";
  }
  return null;
}

export function createUsersApp(db: DB, nwcPool: NWCPool) {
  const hono = new Hono();

  hono.post("/", async (c) => {
    try {
      logger.debug("create user", {});

      const createUserRequest: {
        connectionSecret?: string;
        sparkIdentityPubkey?: string;
        username?: string;
        nostrPubkey: string;
      } = await c.req.json();

      const routed = routeCreateUser(createUserRequest);
      if (routed.kind === "error") {
        return c.text(routed.reason, routed.status);
      }

      let nostrPubkey = normalizeNostrPubkey(createUserRequest.nostrPubkey);
      if (!nostrPubkey) {
        return c.text("no nostr pubkey provided", 400);
      }

      if (!isValid32ByteHex(nostrPubkey)) {
        return c.text("invalid nostr pubkey provided", 400);
      }

      const user = routed.kind === "spark"
        ? await db.createSparkUser(
          routed.sparkIdentityPubkey,
          createUserRequest.username,
          nostrPubkey,
        )
        : await db.createUser(
          routed.connectionSecret,
          createUserRequest.username,
          nostrPubkey,
        );

      const lightningAddress = user.username + "@" + DOMAIN;

      if (routed.kind === "nwc") {
        nwcPool.subscribeUser(routed.connectionSecret, user.id);
      }

      return c.json({
        lightningAddress,
      });
    } catch (error) {
      const taken = usernameTakenReason(error);
      return c.json({ status: "ERROR", reason: taken ?? ("" + error) });
    }
  });

  hono.post("/rebind", async (c) => {
    try {
      const body: {
        username?: string;
        nostrPubkey?: string;
        rebindToken?: string;
        sparkIdentityPubkey?: string;
        connectionSecret?: string;
      } = await c.req.json();

      if (!body.username || !body.rebindToken) {
        return c.text("username and rebindToken are required", 400);
      }

      let nostrPubkey = normalizeNostrPubkey(body.nostrPubkey);
      if (!nostrPubkey) {
        return c.text("no nostr pubkey provided", 400);
      }
      if (!isValid32ByteHex(nostrPubkey)) {
        return c.text("invalid nostr pubkey provided", 400);
      }

      const rebound = await db.rebindUser({
        username: body.username,
        nostrPubkey,
        rebindToken: body.rebindToken,
        sparkIdentityPubkey: body.sparkIdentityPubkey,
        connectionSecret: body.connectionSecret,
      });

      if (rebound.kind === "nwc") {
        nwcPool.subscribeUser(rebound.connectionSecret, rebound.userId);
      } else {
        nwcPool.unsubscribeUser(rebound.userId);
      }

      return c.json({ status: "OK" });
    } catch (error) {
      return c.json({ status: "ERROR", reason: "" + error });
    }
  });

  return hono;
}
