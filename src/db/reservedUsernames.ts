/**
 * Pure helpers for reserved-name checks. The name list lives in
 * `reserved_usernames`; these do not.
 */

const KEY_HEX = /^[0-9a-f]{64}$/;

/** Comparison key: trim, lowercase, then drop `.`, `-`, and `_`. */
export function normalizeReservedName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.\-_]/g, "");
}

/** `npub1…`, `nsec1…`, or 64 hex characters, after the same normalization. */
export function isKeyLikeUsername(raw: string): boolean {
  const normalized = normalizeReservedName(raw);
  return normalized.startsWith("npub1") ||
    normalized.startsWith("nsec1") ||
    KEY_HEX.test(normalized);
}
