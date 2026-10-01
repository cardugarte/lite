import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";

export const registrationCrypto = {
  timingSafeEqual,
};

export function errorEnvelope(reason: string) {
  return { status: "ERROR" as const, reason };
}

function registrationCredentialConfigured(secret: string | undefined): secret is string {
  return secret != null && secret.trim() !== "";
}

function registrationHeaderMatches(presented: string | undefined, secret: string): boolean {
  if (presented == null) return false;
  const presentedBytes = new TextEncoder().encode(presented);
  const secretBytes = new TextEncoder().encode(secret);
  if (presentedBytes.length !== secretBytes.length) return false;
  return registrationCrypto.timingSafeEqual(presentedBytes, secretBytes);
}

/** 503 when the secret is unset, then 403 when the header does not match. Null when authorized. */
export function requireRegistrationSecret(c: Context): Response | null {
  const secret = Deno.env.get("TRAVELSATS_REGISTRATION_SECRET");
  if (!registrationCredentialConfigured(secret)) {
    return c.json(errorEnvelope("registration credential not configured"), 503);
  }
  const presented = c.req.header("X-Travelsats-Registration");
  if (!registrationHeaderMatches(presented, secret)) {
    return c.json(errorEnvelope("forbidden"), 403);
  }
  return null;
}

const NOSTR_PUBKEY_HEX = /^[0-9a-fA-F]{64}$/;

export function readAssertedNostrPubkey(
  c: Context,
): { ok: true; pubkey: string } | { ok: false; response: Response } {
  const presented = c.req.header("X-Travelsats-Nostr-Pubkey");
  if (!presented || !NOSTR_PUBKEY_HEX.test(presented)) {
    return {
      ok: false,
      response: c.json(errorEnvelope("missing or invalid npub assertion"), 400),
    };
  }
  return { ok: true, pubkey: presented.toLowerCase() };
}
