import { nip19 } from "@nostr/tools";
import { Hono } from "hono";
import { errorEnvelope, requireRegistrationSecret } from "./auth/bff.ts";
import { DOMAIN } from "./constants.ts";
import { encrypt } from "./db/aesgcm.ts";
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

      const username = (createUserRequest.username ||
        Math.floor(Math.random() * 100000000000).toString()).toLowerCase();
      const created = await db.createUser({
        npubHex: nostrPubkey,
        username,
        encryptedSecret: await encrypt(routed.connectionSecret),
        now: new Date(),
      });
      if (created.kind === "conflict") {
        // L7.1 maps every conflict reason to its exact status and text.
        const reason = created.reason === "username_taken"
          ? "Username has already been taken"
          : "conflict";
        return c.json(errorEnvelope(reason), 409);
      }

      nwcPool.subscribeUser(routed.connectionSecret, created.user.id);

      return c.json({
        lightningAddress: created.user.username + "@" + DOMAIN,
      });
    } catch (error) {
      logger.error("create user failed", {
        errorName: error instanceof Error ? error.name : "Error",
      });
      return c.json(errorEnvelope("internal error"), 500);
    }
  });

  return hono;
}
