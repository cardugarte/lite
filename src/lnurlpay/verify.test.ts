import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, utf8ToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { secp256k1 } from "npm:@noble/curves@1.2.0/secp256k1";
import { available, recover, register, unregister } from "./signedMessage.ts";
import {
  claimExpiresAt,
  isFresh,
  parseDerSignature,
  parsePubkey,
  statementHash,
  verifySignedMessage,
} from "./verify.ts";

// Key `[0x11; 32]` (Breez `transfer_key(0x11)`); noble signs RFC 6979 low-S, like rust-secp256k1.
const PRIVATE_KEY = new Uint8Array(32).fill(0x11);
const PUBKEY = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const OTHER_PRIVATE_KEY = new Uint8Array(32).fill(0x22);
const OTHER_PUBKEY = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
// x = 5 has no y on secp256k1: well-formed hex, not a curve point.
const NON_CURVE_PUBKEY = "020000000000000000000000000000000000000000000000000000000000000005";
const DOMAIN = "lnurl.example.com";
const TS = 1_700_000_000;

function sign(message: string, key = PRIVATE_KEY) {
  return secp256k1.sign(sha256(utf8ToBytes(message)), key);
}

function signHex(message: string, key = PRIVATE_KEY): string {
  return sign(message, key).toDERHex();
}

function highSTwinHex(message: string): string {
  const signature = sign(message);
  return new secp256k1.Signature(signature.r, secp256k1.CURVE.n - signature.s).toDERHex();
}

Deno.test("the test key derives the pinned public keys", () => {
  expect(bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))).toBe(PUBKEY);
  expect(bytesToHex(secp256k1.getPublicKey(OTHER_PRIVATE_KEY, true))).toBe(OTHER_PUBKEY);
});

Deno.test("a signature verifies over each route's message", () => {
  const messages = [
    register(DOMAIN, "alice", "Sats for alice", TS),
    unregister(DOMAIN, "alice", TS),
    recover(DOMAIN, PUBKEY, TS),
    available(DOMAIN, PUBKEY, "alice", TS),
  ];
  for (const message of messages) {
    expect(verifySignedMessage(PUBKEY, signHex(message), message)).toBe(true);
  }
});

Deno.test("the same signature fails over another domain, route, field, or key", () => {
  const message = register(DOMAIN, "alice", "Sats for alice", TS);
  const signature = signHex(message);
  expect(verifySignedMessage(PUBKEY, signature, register("other.example.com", "alice", "Sats for alice", TS)))
    .toBe(false);
  expect(verifySignedMessage(PUBKEY, signature, register(DOMAIN, "alicf", "Sats for alice", TS))).toBe(false);
  expect(verifySignedMessage(PUBKEY, signature, register(DOMAIN, "alice", "Other", TS))).toBe(false);
  expect(verifySignedMessage(PUBKEY, signature, register(DOMAIN, "alice", "Sats for alice", TS + 1))).toBe(false);
  expect(verifySignedMessage(PUBKEY, signature, unregister(DOMAIN, "alice", TS))).toBe(false);
  expect(verifySignedMessage(OTHER_PUBKEY, signature, message)).toBe(false);
});

Deno.test("a legacy untimestamped-style message does not verify against a v2 signature", () => {
  const v2 = register(DOMAIN, "alice", "Sats for alice", TS);
  expect(verifySignedMessage(PUBKEY, signHex(v2), `alice-${TS}`)).toBe(false);
  expect(verifySignedMessage(PUBKEY, signHex(`alice-${TS}`), v2)).toBe(false);
});

Deno.test("the high-S twin of a valid signature is rejected", () => {
  const message = recover(DOMAIN, PUBKEY, TS);
  const valid = signHex(message);
  const twin = highSTwinHex(message);
  expect(twin).not.toBe(valid);
  expect(parseDerSignature(twin)).not.toBeNull();
  expect(verifySignedMessage(PUBKEY, valid, message)).toBe(true);
  expect(verifySignedMessage(PUBKEY, twin, message)).toBe(false);
});

Deno.test("compact and non-hex signatures do not parse", () => {
  const message = recover(DOMAIN, PUBKEY, TS);
  const compact = sign(message).toCompactHex();
  expect(compact.length).toBe(128);
  expect(parseDerSignature(compact)).toBeNull();
  expect(parseDerSignature("not-hex")).toBeNull();
  expect(parseDerSignature("")).toBeNull();
  expect(parseDerSignature("3006")).toBeNull();
  expect(parseDerSignature(signHex(message))).not.toBeNull();
  expect(verifySignedMessage(PUBKEY, compact, message)).toBe(false);
  expect(verifySignedMessage(PUBKEY, "not-hex", message)).toBe(false);
});

Deno.test("parsePubkey accepts compressed curve points and normalizes to lowercase", () => {
  expect(parsePubkey(PUBKEY)).toBe(PUBKEY);
  expect(parsePubkey(PUBKEY.toUpperCase())).toBe(PUBKEY);
  expect(parsePubkey(NON_CURVE_PUBKEY)).toBeNull();
  expect(parsePubkey("zz")).toBeNull();
  expect(parsePubkey("04" + PUBKEY.slice(2))).toBeNull();
  expect(parsePubkey(PUBKEY.slice(0, 64))).toBeNull();
  expect(verifySignedMessage(PUBKEY.toUpperCase(), signHex("m"), "m")).toBe(true);
  expect(verifySignedMessage(NON_CURVE_PUBKEY, signHex("m"), "m")).toBe(false);
});

Deno.test("isFresh accepts the inclusive 600 second window and rejects beyond it", () => {
  const nowMs = TS * 1000;
  expect(isFresh(TS - 600, nowMs)).toBe(true);
  expect(isFresh(TS + 600, nowMs)).toBe(true);
  expect(isFresh(TS - 601, nowMs)).toBe(false);
  expect(isFresh(TS + 601, nowMs)).toBe(false);
  // 600.001 s in milliseconds is outside the window even though the seconds floor to 600.
  expect(isFresh(TS + 600, nowMs - 1)).toBe(false);
  expect(isFresh(TS - 600, nowMs + 1)).toBe(false);
  expect(isFresh(-1, 0)).toBe(false);
  expect(isFresh(1.5, 1500)).toBe(false);
  expect(isFresh(Number.MAX_SAFE_INTEGER + 1, nowMs)).toBe(false);
});

Deno.test("claimExpiresAt is the signed timestamp plus 600 seconds", () => {
  expect(claimExpiresAt(1_700_000_000)).toEqual(new Date(1_700_000_600 * 1000));
  expect(claimExpiresAt(0)).toEqual(new Date(600 * 1000));
});

Deno.test("statementHash is sha256 of pubkey, a zero byte, and the message", () => {
  // Independent vector, computed in a shell:
  //   PK=02a1633c...51b5dc
  //   MSG=$'breez-lnurl:v2\nrecover\nlnurl.example.com\n<PK>\n1700000000'
  //   printf '%s\0%s' "$PK" "$MSG" | shasum -a 256
  const pubkey = "02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc";
  const message = recover(DOMAIN, pubkey, TS);
  expect(statementHash(pubkey, message)).toBe(
    "cbf1727442924c0f88c17b2e684a629487eb2e1036e8ec3cc6c558ab9d24cd93",
  );
  // The zero byte separates the fields: moving a character across it changes the hash.
  expect(statementHash("ab", "cd")).not.toBe(statementHash("abc", "d"));
});
