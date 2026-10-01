import { nip19 } from "@nostr/tools";
import { Hono } from "hono";
import type { Context } from "hono";
import { errorEnvelope, readAssertedNostrPubkey, requireRegistrationSecret } from "./auth/bff.ts";
import { LNURL_DOMAIN } from "./constants.ts";
import { encrypt } from "./db/aesgcm.ts";
import { DB } from "./db/db.ts";
import {
  normalizeUsername,
  parseNwcConnectionSecret,
  SPARK_PUBKEY_REGEX,
  usernameProblem,
} from "./db/userValues.ts";
import { logger } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import { routeCreateUser } from "./spark/destination.ts";
import { isValid32ByteHex } from "./utils.ts";

const CREATE_CONFLICT_TEXT = {
  username_taken: "Username has already been taken",
  account_exists: "Account already has a Lightning Address",
  name_in_progress: "name is being registered",
} as const;

const INTENT_CONFLICT_TEXT = {
  name_taken: "name already taken",
  account_username_differs: "account holds a different username",
  pubkey_taken: "pubkey already holds an address",
  name_in_progress: "name is being registered",
} as const;

function normalizeNostrPubkey(nostrPubkey: string | undefined): string | null {
  if (!nostrPubkey) return null;
  if (nostrPubkey.startsWith("npub")) {
    return nip19.decode(nostrPubkey).data as string;
  }
  return nostrPubkey;
}

function connectionSecretError(connectionSecret: string): string | null {
  try {
    parseNwcConnectionSecret(connectionSecret);
    return null;
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "invalid connection secret";
  }
}

function internalError(c: Context, message: string, error: unknown) {
  logger.error(message, { errorName: error instanceof Error ? error.name : "Error" });
  return c.json(errorEnvelope("internal error"), 500);
}

/** Parses the request body as a JSON object; the failure is the response to send. */
async function readJsonObject(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return { ok: false, response: c.json(errorEnvelope("invalid json"), 400) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: c.json(errorEnvelope("invalid request"), 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Secret-authenticated writes. `now` is Lite's injectable clock. */
export function createUsersApp(db: DB, nwcPool: NWCPool, now: () => Date = () => new Date()) {
  const hono = new Hono();

  hono.post("/", async (c) => {
    const denied = requireRegistrationSecret(c);
    if (denied) return denied;

    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.response;
    const createUserRequest = parsed.body as {
      connectionSecret?: string;
      sparkIdentityPubkey?: string;
      username?: string;
      nostrPubkey?: string;
    };
    if (createUserRequest.username !== undefined && typeof createUserRequest.username !== "string") {
      return c.json(errorEnvelope("invalid request"), 400);
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

      const secretError = connectionSecretError(routed.connectionSecret);
      if (secretError) return c.json(errorEnvelope(secretError), 400);

      // TODO: use haikunator
      const username = normalizeUsername(
        createUserRequest.username || Math.floor(Math.random() * 100000000000).toString(),
      );
      const created = await db.createUser({
        npubHex: nostrPubkey.toLowerCase(),
        username,
        encryptedSecret: await encrypt(routed.connectionSecret),
        now: now(),
      });
      if (created.kind === "conflict") {
        return c.json(errorEnvelope(CREATE_CONFLICT_TEXT[created.reason]), 409);
      }

      nwcPool.subscribeUser(routed.connectionSecret, created.user.id);

      return c.json({
        lightningAddress: created.user.username + "@" + LNURL_DOMAIN,
      });
    } catch (error) {
      return internalError(c, "create user failed", error);
    }
  });

  hono.post("/binding-intents", async (c) => {
    const denied = requireRegistrationSecret(c);
    if (denied) return denied;
    const asserted = readAssertedNostrPubkey(c);
    if (!asserted.ok) return asserted.response;
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.response;

    const { username: rawUsername, sparkPubkey } = parsed.body;
    if (typeof rawUsername !== "string") {
      return c.json(errorEnvelope("invalid username"), 400);
    }
    const username = normalizeUsername(rawUsername);
    const problem = usernameProblem(username);
    if (problem) {
      return c.json(errorEnvelope(problem === "too_long" ? "username too long" : "invalid username"), 400);
    }
    if (typeof sparkPubkey !== "string" || !SPARK_PUBKEY_REGEX.test(sparkPubkey)) {
      return c.json(errorEnvelope("invalid sparkPubkey"), 400);
    }

    try {
      const result = await db.createBindingIntent({
        npubHex: asserted.pubkey,
        username,
        sparkPubkey,
        now: now(),
      });
      if (result.kind === "conflict") {
        return c.json(errorEnvelope(INTENT_CONFLICT_TEXT[result.reason]), 409);
      }
      return c.json({ expiresAt: result.expiresAt.toISOString() });
    } catch (error) {
      return internalError(c, "create binding intent failed", error);
    }
  });

  hono.post("/nwc-bind", async (c) => {
    const denied = requireRegistrationSecret(c);
    if (denied) return denied;
    const asserted = readAssertedNostrPubkey(c);
    if (!asserted.ok) return asserted.response;
    const parsed = await readJsonObject(c);
    if (!parsed.ok) return parsed.response;

    const connectionSecret = parsed.body.connectionSecret;
    if (typeof connectionSecret !== "string" || connectionSecret === "") {
      return c.json(errorEnvelope("no connection secret provided"), 400);
    }
    const secretError = connectionSecretError(connectionSecret);
    if (secretError) return c.json(errorEnvelope(secretError), 400);

    try {
      const result = await db.bindNwcDestination(
        asserted.pubkey,
        await encrypt(connectionSecret),
        now(),
      );
      if (result.kind === "not_found") {
        return c.json(errorEnvelope("user not found"), 404);
      }
      if (result.kind === "conflict") {
        return c.json(errorEnvelope(CREATE_CONFLICT_TEXT[result.reason]), 409);
      }
      // subscribeUser replaces any existing subscription for the row.
      nwcPool.subscribeUser(connectionSecret, result.user.id);
      return c.json({ lightningAddress: result.user.username + "@" + LNURL_DOMAIN });
    } catch (error) {
      return internalError(c, "nwc bind failed", error);
    }
  });

  hono.delete("/", async (c) => {
    const denied = requireRegistrationSecret(c);
    if (denied) return denied;
    const asserted = readAssertedNostrPubkey(c);
    if (!asserted.ok) return asserted.response;

    try {
      const existing = await db.findUserByNostrPubkey(asserted.pubkey);
      const removed = await db.deleteUserByNostrPubkey(asserted.pubkey);
      if (existing && removed > 0) nwcPool.unsubscribeUser(existing.id);
      return c.json({ removed });
    } catch (error) {
      return internalError(c, "abandon user failed", error);
    }
  });

  return hono;
}
