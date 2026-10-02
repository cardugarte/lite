import { expect } from "jsr:@std/expect";
import { nwc } from "npm:@getalby/sdk";
import { normalizeUsername, parseNwcConnectionSecret, usernameProblem } from "./userValues.ts";

const NWC_URL =
  "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";

Deno.test("NWC createUser still parses a wallet connect URI with a secret", () => {
  const parsed = parseNwcConnectionSecret(NWC_URL);
  expect(parsed.secret).toEqual(
    "bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33",
  );
  expect(nwc.NWCClient.parseWalletConnectUrl(NWC_URL).secret).toEqual(
    parsed.secret,
  );
});

Deno.test("NWC createUser still throws when the URI has no secret", () => {
  expect(() =>
    parseNwcConnectionSecret(
      "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1",
    )
  ).toThrow("no secret found in connection secret");
});

Deno.test("normalizeUsername trims and lowercases", () => {
  expect(normalizeUsername("  Alice ")).toBe("alice");
  expect(normalizeUsername("BOB.Smith")).toBe("bob.smith");
});

Deno.test("usernameProblem accepts the Breez username form", () => {
  const accepted = ["alice", "a", "a.b", "first.last.name", "user_name", "a+b", "x!#$%&'*+/=?^_`{|}~-y", "12345"];
  for (const name of accepted) expect(usernameProblem(name)).toBeNull();
  expect(usernameProblem("a".repeat(64))).toBeNull();
});

Deno.test("usernameProblem rejects leading, trailing, and consecutive dots and other characters", () => {
  const rejected = [".alice", "alice.", "a..b", "has space", "tab\tname", "new\nline", "ali@ce", "ali\u00e7e", ""];
  for (const name of rejected) expect(usernameProblem(name)).toBe("invalid");
});

Deno.test("usernameProblem reports a name longer than 64 characters as too long", () => {
  expect(usernameProblem("a".repeat(65))).toBe("too_long");
  expect(usernameProblem(("a".repeat(30) + ".").repeat(3))).toBe("too_long");
});
