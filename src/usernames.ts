import { Hono } from "hono";
import { errorEnvelope } from "./auth/bff.ts";
import type { DB } from "./db/db.ts";
import { isKeyLikeUsername } from "./db/reservedUsernames.ts";
import { normalizeUsername, usernameProblem } from "./db/userValues.ts";
import { isValid32ByteHex } from "./utils.ts";
import { availabilityClientIp, availabilityRateConfig, createSlidingWindowLimiter } from "./usernames/rateLimit.ts";

/**
 * Public availability. False for an invalid name, a taken name, a hard
 * reservation, or an assignable name not assigned to `pubkey`. The body is
 * only `{ available }`. Each client IP gets the PWA `user_profile` budget.
 */
export function createUsernamesApp(
  db: DB,
  now: () => Date = () => new Date(),
  rate: { limit: number; windowMs: number } = availabilityRateConfig(),
) {
  const hono = new Hono();
  const { limit, windowMs } = rate;
  const limiter = createSlidingWindowLimiter(limit, windowMs, () => now().getTime());

  hono.get("/:username/availability", async (c) => {
    const decision = limiter.take(availabilityClientIp(c.req.raw.headers));
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(errorEnvelope("too many requests"), 429);
    }
    const rawPubkey = c.req.query("pubkey");
    if (rawPubkey !== undefined && !isValid32ByteHex(rawPubkey)) {
      return c.json(errorEnvelope("invalid pubkey"), 400);
    }
    const pubkey = rawPubkey ? rawPubkey.toLowerCase() : null;
    const stored = normalizeUsername(c.req.param("username"));
    if (usernameProblem(stored) || isKeyLikeUsername(stored)) {
      return c.json({ available: false });
    }
    const reserved = await db.isReservedUsername(stored, pubkey, now());
    if (reserved) return c.json({ available: false });
    const taken = await db.findUserByUsername(stored);
    if (taken) return c.json({ available: false });
    const intent = await db.findActiveBindingIntent(stored, now());
    return c.json({ available: !intent });
  });

  return hono;
}
