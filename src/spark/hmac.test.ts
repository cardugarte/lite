import { expect } from "jsr:@std/expect";
import { hmac } from "npm:@noble/hashes@1.3.1/hmac";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { paymentHashFromPreimage, verifySparkSignature } from "./hmac.ts";

const SECRET = "webhook-secret";
const BODY = '{"type":"SPARK_LIGHTNING_RECEIVE_FINISHED","payment_preimage":"aa"}';

function independentHmac(secret: string, body: string): string {
  return bytesToHex(
    hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(body)),
  );
}

Deno.test("webhook HMAC accepts a valid X-Spark-Signature", () => {
  const signature = independentHmac(SECRET, BODY);
  expect(verifySparkSignature(SECRET, BODY, signature)).toBe(true);
  expect(verifySparkSignature(SECRET, BODY, signature.toUpperCase())).toBe(true);
});

Deno.test("webhook HMAC rejects a bad or missing signature", () => {
  const signature = independentHmac(SECRET, BODY);
  expect(verifySparkSignature(SECRET, BODY, "00".repeat(32))).toBe(false);
  expect(verifySparkSignature(SECRET, BODY, signature.slice(0, -2) + "ff")).toBe(false);
  expect(verifySparkSignature(SECRET, BODY, "")).toBe(false);
  expect(verifySparkSignature(SECRET, BODY, null)).toBe(false);
  expect(verifySparkSignature(SECRET, '{"type":"other"}', signature)).toBe(false);
});

Deno.test("payment_hash is sha256 of the decoded preimage bytes", () => {
  const preimage = "11".repeat(32);
  const expected = bytesToHex(sha256(hexToBytes(preimage)));
  expect(paymentHashFromPreimage(preimage)).toEqual(expected);
  expect(paymentHashFromPreimage("0x" + preimage)).toEqual(expected);
});
