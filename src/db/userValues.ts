import { nwc } from "npm:@getalby/sdk";

export const SPARK_PUBKEY_REGEX = /^0[23][0-9a-f]{64}$/;

export function parseNwcConnectionSecret(connectionSecret: string) {
  const parsed = nwc.NWCClient.parseWalletConnectUrl(connectionSecret);
  if (!parsed.secret) {
    throw new Error("no secret found in connection secret");
  }
  return parsed;
}

export const USERNAME_MAX_LENGTH = 64;

/**
 * Breez `USERNAME_VALIDATION_REGEX`: an RFC 5322 unquoted local part. Dots are
 * allowed but not leading, trailing, or consecutive.
 */
export const USERNAME_PATTERN =
  /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** The form the SDK signs and Lite stores: `trim().toLowerCase()` (Breez `lnurl-models`). */
export const normalizeUsername = (raw: string): string => raw.trim().toLowerCase();

/** Why a normalized username is unusable, or null when it is valid. Length is checked before the pattern. */
export function usernameProblem(normalized: string): "too_long" | "invalid" | null {
  if (normalized.length > USERNAME_MAX_LENGTH) return "too_long";
  if (!USERNAME_PATTERN.test(normalized)) return "invalid";
  return null;
}
