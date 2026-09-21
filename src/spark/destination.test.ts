import { expect } from "jsr:@std/expect";
import {
  isSparkUser,
  routeCreateUser,
  shouldSubscribeNwc,
} from "./destination.ts";

Deno.test("NULL destination is nwc, not spark", () => {
  expect(isSparkUser({ destination: null, sparkIdentityPubkey: null })).toBe(
    false,
  );
  expect(
    isSparkUser({ destination: "spark", sparkIdentityPubkey: "02ab" }),
  ).toBe(true);
  expect(
    isSparkUser({ destination: null, sparkIdentityPubkey: "02ab" }),
  ).toBe(true);
});

Deno.test("NWC pool skips spark rows and null connection secrets", () => {
  expect(
    shouldSubscribeNwc({
      destination: "spark",
      encryptedConnectionSecret: null,
    }),
  ).toBe(false);
  expect(
    shouldSubscribeNwc({
      destination: null,
      encryptedConnectionSecret: null,
    }),
  ).toBe(false);
  expect(
    shouldSubscribeNwc({
      destination: null,
      encryptedConnectionSecret: "enc",
    }),
  ).toBe(true);
});

Deno.test("POST /users routes spark when only sparkIdentityPubkey is set", () => {
  expect(
    routeCreateUser({ sparkIdentityPubkey: "02ab", nostrPubkey: "aa" }),
  ).toEqual({
    kind: "spark",
    sparkIdentityPubkey: "02ab",
  });
});

Deno.test("POST /users routes nwc when connectionSecret is set", () => {
  expect(
    routeCreateUser({ connectionSecret: "nostr+walletconnect://x", nostrPubkey: "aa" }),
  ).toEqual({
    kind: "nwc",
    connectionSecret: "nostr+walletconnect://x",
  });
});

Deno.test("POST /users rejects neither destination", () => {
  expect(routeCreateUser({ nostrPubkey: "aa" })).toEqual({
    kind: "error",
    reason: "no connection secret provided",
    status: 400,
  });
});

Deno.test("POST /users rejects both destinations", () => {
  const routed = routeCreateUser({
    connectionSecret: "nostr+walletconnect://x",
    sparkIdentityPubkey: "02ab",
    nostrPubkey: "aa",
  });
  expect(routed.kind).toEqual("error");
  if (routed.kind === "error") {
    expect(routed.status).toEqual(400);
    expect(routed.reason).toMatch(/both/i);
  }
});
