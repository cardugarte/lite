import { paymentHashFromPreimage } from "./spark/hmac.ts";
import { normalizePreimage } from "./spark/settlement.ts";

const PREIMAGE_HEX = /^[0-9a-f]{64}$/;

/**
 * True when `preimage` is 32 bytes of hex whose sha256 is `paymentHash`. Case,
 * a `0x` prefix and surrounding whitespace do not matter. A malformed value is
 * a mismatch, never a throw. A wallet's claim of payment counts only when it
 * passes this check: a preimage that hashes to another value proves nothing
 * about this invoice.
 */
export function preimageMatchesPaymentHash(preimage: string, paymentHash: string): boolean {
  if (typeof preimage !== "string" || typeof paymentHash !== "string") return false;
  const normalized = normalizePreimage(preimage);
  if (!PREIMAGE_HEX.test(normalized)) return false;
  return paymentHashFromPreimage(normalized) === paymentHash.trim().toLowerCase();
}
