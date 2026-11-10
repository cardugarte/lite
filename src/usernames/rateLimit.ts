/**
 * Public username availability uses the PWA `user_profile` budget:
 * 50 requests per 60 seconds (`lib/advanced-rate-limiter.ts` on
 * `travelsats.ar` `development`). The PWA stores that window in Postgres.
 * Lite keeps a per-process sliding window because it has no shared limiter.
 * Override with `USERNAME_AVAILABILITY_RATE_LIMIT` and
 * `USERNAME_AVAILABILITY_RATE_WINDOW_SECONDS`.
 */
export const USERNAME_AVAILABILITY_RATE_LIMIT = 50;
export const USERNAME_AVAILABILITY_RATE_WINDOW_SECONDS = 60;

export function availabilityRateConfig(
  env: { get(name: string): string | undefined } = Deno.env,
): { limit: number; windowMs: number } {
  return {
    limit: positiveInt(env.get("USERNAME_AVAILABILITY_RATE_LIMIT"), USERNAME_AVAILABILITY_RATE_LIMIT),
    windowMs: positiveInt(
      env.get("USERNAME_AVAILABILITY_RATE_WINDOW_SECONDS"),
      USERNAME_AVAILABILITY_RATE_WINDOW_SECONDS,
    ) * 1000,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

/**
 * Fly sets `Fly-Client-IP` to the address that connected to the proxy.
 * A client-supplied `X-Forwarded-For` list is only used when Fly did not
 * set that header, and then only its last hop: the leftmost entries are
 * whatever the caller wrote.
 */
export function availabilityClientIp(headers: Headers): string {
  const fly = singleIp(headers.get("fly-client-ip"));
  if (fly) return fly;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((part) => part.trim()).filter((part) => part !== "");
    const last = singleIp(hops[hops.length - 1]);
    if (last) return last;
  }
  return "unknown";
}

function singleIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ip = value.trim();
  if (ip === "" || ip.includes(",") || /\s/.test(ip)) return null;
  return ip;
}

export function createSlidingWindowLimiter(limit: number, windowMs: number, now: () => number) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((stamp) => stamp > at - windowMs);
      if (recent.length >= limit) {
        const retryMs = recent[0] + windowMs - at;
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
      }
      recent.push(at);
      hits.set(key, recent);
      return { allowed: true };
    },
  };
}
