import type { Context } from "hono";
import { errorEnvelope, registrationCrypto } from "./bff.ts";

function configuredToken(): string | null {
  const token = Deno.env.get("LITE_ADMIN_TOKEN");
  if (token == null || token.trim() === "") return null;
  return token;
}

function tokensMatch(presented: string, secret: string): boolean {
  const presentedBytes = new TextEncoder().encode(presented);
  const secretBytes = new TextEncoder().encode(secret);
  if (presentedBytes.length !== secretBytes.length) return false;
  return registrationCrypto.timingSafeEqual(presentedBytes, secretBytes);
}

/**
 * Fail closed. 401 when admin auth is not configured or the caller did not
 * send a bearer token. 403 when a bearer token was sent and does not match.
 * The token is never logged.
 */
export function requireAdminToken(c: Context): Response | null {
  const secret = configuredToken();
  if (!secret) return c.json(errorEnvelope("unauthorized"), 401);
  const header = c.req.header("Authorization");
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!match) return c.json(errorEnvelope("unauthorized"), 401);
  if (!tokensMatch(match[1], secret)) return c.json(errorEnvelope("forbidden"), 403);
  return null;
}
