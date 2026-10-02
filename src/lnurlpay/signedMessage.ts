import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, utf8ToBytes } from "npm:@noble/hashes@1.3.1/utils";

/**
 * Canonical messages the identity key signs to authorize a breez-lnurl v2
 * request, ported from Breez `lnurl-models/src/signed_message.rs`. Fields are
 * joined by LF; the one free-form field (the description) enters hashed, so no
 * value can shift the fields that follow it.
 */

/** First field of every message: namespace plus version. */
export const VERSION = "breez-lnurl:v2";

/** How far a message timestamp may sit from the verifier's clock, in either direction. */
export const VALIDITY_SECS = 600;

const SEPARATOR = "\n";

/** Lowercase hex sha256 of the exact description bytes (never trimmed or normalized). */
export const descriptionHash = (description: string): string =>
  bytesToHex(sha256(utf8ToBytes(description)));

const join = (fields: string[]): string => fields.join(SEPARATOR);

/** `POST /lnurlpay/{pubkey}`: claim `username` on `domain`. */
export const register = (
  domain: string,
  username: string,
  description: string,
  timestamp: number,
): string =>
  join([VERSION, "register", domain, username, descriptionHash(description), String(timestamp)]);

/** `DELETE /lnurlpay/{pubkey}`: give up `username` on `domain`. */
export const unregister = (domain: string, username: string, timestamp: number): string =>
  join([VERSION, "unregister", domain, username, String(timestamp)]);

/** `POST /lnurlpay/{pubkey}/recover`: read back the address `pubkey` holds on `domain`. */
export const recover = (domain: string, pubkey: string, timestamp: number): string =>
  join([VERSION, "recover", domain, pubkey, String(timestamp)]);

/** `POST /lnurlpay/{pubkey}/available`: ask whether `pubkey` may register `username` on `domain`. */
export const available = (
  domain: string,
  pubkey: string,
  username: string,
  timestamp: number,
): string => join([VERSION, "available", domain, pubkey, username, String(timestamp)]);
