import { hmac } from "npm:@noble/hashes@1.3.1/hmac";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

export function hmacSha256Hex(secret: string, body: string): string {
  return bytesToHex(
    hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(body)),
  );
}

export function verifySparkSignature(
  secret: string,
  body: string,
  signature: string | null | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = hmacSha256Hex(secret, body);
  let provided: Uint8Array;
  try {
    provided = hexToBytes(signature.trim().toLowerCase());
  } catch {
    return false;
  }
  return timingSafeEqual(hexToBytes(expected), provided);
}

export function paymentHashFromPreimage(preimageHex: string): string {
  const hex = preimageHex.trim().replace(/^0x/i, "");
  return bytesToHex(sha256(hexToBytes(hex)));
}
