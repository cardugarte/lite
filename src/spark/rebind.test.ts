import { expect } from "jsr:@std/expect";
import {
  assertRebindFresh,
  assertRebindNostr,
  consumeRebindTokenCount,
  hashRebindToken,
} from "./rebind.ts";

Deno.test("rebind rejects a replayed token", () => {
  expect(() =>
    assertRebindFresh(
      { username: "alice", usedAt: new Date("2026-01-01T00:00:00Z") },
      "alice",
    )
  ).toThrow("rebind token already used");
});

Deno.test("rebind rejects a token issued to another username", () => {
  expect(() =>
    assertRebindFresh({ username: "bob", usedAt: null }, "alice")
  ).toThrow("invalid rebind token");
  expect(() => assertRebindFresh(null, "alice")).toThrow("invalid rebind token");
});

Deno.test("rebind requires the existing nostr pubkey", () => {
  expect(() => assertRebindNostr("aa".repeat(32), "bb".repeat(32))).toThrow(
    "unauthorized",
  );
  expect(() => assertRebindNostr("aa".repeat(32), "aa".repeat(32))).not.toThrow();
});

Deno.test("consumeRebindTokenCount rejects a miss so a replay cannot rewrite the user", () => {
  expect(() => consumeRebindTokenCount(0)).toThrow("invalid rebind token");
  expect(() => consumeRebindTokenCount(1)).not.toThrow();
});

Deno.test("rebind token hash is sha256 of the presented token", () => {
  const token = "deadbeef";
  expect(hashRebindToken(token)).toHaveLength(64);
  expect(hashRebindToken(token)).toEqual(hashRebindToken(token));
  expect(hashRebindToken(token)).not.toEqual(hashRebindToken("other"));
});
