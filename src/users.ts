import { nip19 } from "@nostr/tools";
import { Hono } from "hono";
import postgres from "postgres";
import { errorEnvelope, requireRegistrationSecret } from "./auth/bff.ts";
import { DOMAIN } from "./constants.ts";
import { DB } from "./db/db.ts";
import { parseNwcConnectionSecret } from "./db/userValues.ts";
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
    const denied = requireRegistrationSecret(c);
    if (denied) return denied;

    let createUserRequest: {
      connectionSecret?: string;
      sparkIdentityPubkey?: string;
      username?: string;
      nostrPubkey?: string;
    };
    try {
      createUserRequest = await c.req.json();
    } catch {
      return c.json(errorEnvelope("invalid json"), 400);
    }

    try {
      logger.debug("create user", {});

      const routed = routeCreateUser(createUserRequest);
      if (routed.kind === "error") {
        return c.json(errorEnvelope(routed.reason), routed.status);
      }

      let nostrPubkey: string | null;
      try {
        nostrPubkey = normalizeNostrPubkey(createUserRequest.nostrPubkey);
      } catch {
        return c.json(errorEnvelope("invalid nostr pubkey provided"), 400);
      }
      if (!nostrPubkey) {
        return c.json(errorEnvelope("no nostr pubkey provided"), 400);
      }
      if (!isValid32ByteHex(nostrPubkey)) {
        return c.json(errorEnvelope("invalid nostr pubkey provided"), 400);
      }

      if (routed.kind === "nwc") {
        try {
          parseNwcConnectionSecret(routed.connectionSecret);
        } catch (error) {
          const reason = error instanceof Error && error.message
            ? error.message
            : "invalid connection secret";
          return c.json(errorEnvelope(reason), 400);
        }
      }

      const user = await db.createUser(
        routed.connectionSecret,
        createUserRequest.username,
        nostrPubkey,
      );

      nwcPool.subscribeUser(routed.connectionSecret, user.id);

      return c.json({
        lightningAddress: user.username + "@" + DOMAIN,
      });
    } catch (error) {
      const taken = usernameTakenReason(error);
      if (taken) return c.json(errorEnvelope(taken), 409);
      logger.error("create user failed", {
        errorName: error instanceof Error ? error.name : "Error",
      });
      return c.json(errorEnvelope("internal error"), 500);
    }
  });

  return hono;
}
