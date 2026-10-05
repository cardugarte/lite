import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { preimageMatchesPaymentHash } from "./preimage.ts";

const PREIMAGE = "11".repeat(32);
// Computed here, not by the code under test.
const HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));

Deno.test("a preimage matches the payment hash it hashes to", () => {
  expect(preimageMatchesPaymentHash(PREIMAGE, HASH)).toBe(true);
});

Deno.test("the comparison ignores case, a 0x prefix and surrounding whitespace", () => {
  expect(preimageMatchesPaymentHash(PREIMAGE.toUpperCase(), HASH)).toBe(true);
  expect(preimageMatchesPaymentHash(`0x${PREIMAGE}`, HASH)).toBe(true);
  expect(preimageMatchesPaymentHash(`  ${PREIMAGE}\n`, HASH)).toBe(true);
  expect(preimageMatchesPaymentHash(PREIMAGE, HASH.toUpperCase())).toBe(true);
});

Deno.test("a preimage that hashes to another value does not match", () => {
  expect(preimageMatchesPaymentHash("22".repeat(32), HASH)).toBe(false);
  expect(preimageMatchesPaymentHash(PREIMAGE, "aa".repeat(32))).toBe(false);
});

Deno.test("a malformed preimage is a mismatch, never a throw", () => {
  for (const preimage of ["", "   ", "not hex", "zz".repeat(32), "11".repeat(31), "11".repeat(33), "1".repeat(63)]) {
    expect(preimageMatchesPaymentHash(preimage, HASH)).toBe(false);
  }
});
