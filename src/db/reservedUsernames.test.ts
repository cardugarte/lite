import { expect } from "jsr:@std/expect";
import { isKeyLikeUsername, normalizeReservedName } from "./reservedUsernames.ts";

Deno.test("normalizeReservedName trims, lowercases, and strips separators", () => {
  expect(normalizeReservedName("  Hel.Lo ")).toBe("hello");
  expect(normalizeReservedName("Zu_ri-cata")).toBe("zuricata");
  expect(normalizeReservedName("men.doza")).toBe("mendoza");
});

Deno.test("isKeyLikeUsername matches npub, nsec, and 64-char hex after normalization", () => {
  expect(isKeyLikeUsername("npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(true);
  expect(isKeyLikeUsername("Npub1QQQ")).toBe(true);
  expect(isKeyLikeUsername("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe(true);
  expect(isKeyLikeUsername("NSEC1abc")).toBe(true);
  expect(isKeyLikeUsername("ab".repeat(32))).toBe(true);
  expect(isKeyLikeUsername("AB".repeat(32))).toBe(true);
  expect(isKeyLikeUsername("ab-".repeat(16) + "ab".repeat(16))).toBe(true);
  expect(isKeyLikeUsername("a".repeat(63))).toBe(false);
  expect(isKeyLikeUsername("npub")).toBe(false);
  expect(isKeyLikeUsername("nsec")).toBe(false);
  expect(isKeyLikeUsername("alice")).toBe(false);
  expect(isKeyLikeUsername("")).toBe(false);
});
