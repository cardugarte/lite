import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex } from "npm:@noble/hashes@1.3.1/utils";

export type RebindTokenRow = {
  id?: number;
  username: string;
  usedAt: Date | null;
};

export function hashRebindToken(token: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}

export function newRebindToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function assertRebindFresh(
  token: RebindTokenRow | null | undefined,
  username: string,
): RebindTokenRow {
  if (!token || token.username !== username) {
    throw new Error("invalid rebind token");
  }
  if (token.usedAt) {
    throw new Error("rebind token already used");
  }
  return token;
}

export function assertRebindNostr(stored: string, presented: string): void {
  if (!stored || stored !== presented) {
    throw new Error("unauthorized");
  }
}
