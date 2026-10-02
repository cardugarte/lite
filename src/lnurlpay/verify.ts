import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, concatBytes, utf8ToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { secp256k1 } from "npm:@noble/curves@1.2.0/secp256k1";
import { VALIDITY_SECS } from "./signedMessage.ts";

const COMPRESSED_PUBKEY = /^0[23][0-9a-fA-F]{64}$/;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * Normalizes a compressed secp256k1 public key to lowercase hex, or null when
 * it is not 66 hex characters or not a point on the curve.
 */
export function parsePubkey(pubkeyHex: string): string | null {
  if (!COMPRESSED_PUBKEY.test(pubkeyHex)) return null;
  const normalized = pubkeyHex.toLowerCase();
  try {
    secp256k1.ProjectivePoint.fromHex(normalized);
  } catch {
    return null;
  }
  return normalized;
}

/** Strict DER only (Breez `from_der`): compact encodings, non-hex, and trailing bytes yield null. */
export function parseDerSignature(signatureHex: string) {
  if (!HEX_BYTES.test(signatureHex)) return null;
  try {
    return secp256k1.Signature.fromDER(signatureHex);
  } catch {
    return null;
  }
}

/**
 * Verifies a DER signature over `sha256(utf8(message))`. High-S signatures are
 * rejected, matching rust-secp256k1.
 */
export function verifySignedMessage(
  pubkeyHex: string,
  signatureDerHex: string,
  message: string,
): boolean {
  const pubkey = parsePubkey(pubkeyHex);
  const signature = parseDerSignature(signatureDerHex);
  if (!pubkey || !signature) return false;
  try {
    return secp256k1.verify(signature, sha256(utf8ToBytes(message)), pubkey, { lowS: true });
  } catch {
    return false;
  }
}

/**
 * True when the signed timestamp (Unix seconds) sits within the inclusive
 * validity window of Lite's clock. `nowMs` is the same clock in milliseconds,
 * so the boundary is exact to the millisecond.
 */
export const isFresh = (timestampSecs: number, nowMs: number): boolean =>
  Number.isSafeInteger(timestampSecs) && timestampSecs >= 0 &&
  Math.abs(timestampSecs * 1000 - nowMs) <= VALIDITY_SECS * 1000;

/** A statement is acceptable until `ts + VALIDITY_SECS`, so its claim is needed exactly that long. */
export const claimExpiresAt = (timestampSecs: number): Date =>
  new Date((timestampSecs + VALIDITY_SECS) * 1000);

/** `sha256(pubkeyHex || 0x00 || message)` as lowercase hex (Breez `routes.rs` statement hash). */
export const statementHash = (pubkeyHex: string, message: string): string =>
  bytesToHex(sha256(concatBytes(utf8ToBytes(pubkeyHex), new Uint8Array([0x00]), utf8ToBytes(message))));
