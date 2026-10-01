import { expect } from "jsr:@std/expect";
import {
  isSparkUser,
  routeCreateUser,
  shouldSubscribeNwc,
} from "./destination.ts";

Deno.test("destination kind comes from the destination column only", () => {
  expect(isSparkUser({ destination: "spark", sparkIdentityPubkey: "02ab" })).toBe(
    true,
  );
  expect(shouldSubscribeNwc({
    destination: "spark",
    encryptedConnectionSecret: "enc",
  })).toBe(false);

  expect(isSparkUser({ destination: "nwc", sparkIdentityPubkey: null })).toBe(
    false,
  );
  expect(shouldSubscribeNwc({
    destination: "nwc",
    encryptedConnectionSecret: "enc",
  })).toBe(true);
  expect(shouldSubscribeNwc({
    destination: "nwc",
    encryptedConnectionSecret: null,
  })).toBe(false);
  expect(shouldSubscribeNwc({
    destination: "nwc",
    encryptedConnectionSecret: "",
  })).toBe(false);

  expect(isSparkUser({
    destination: "nwc",
    sparkIdentityPubkey: "02ab",
  })).toBe(false);
  expect(isSparkUser({
    destination: null,
    sparkIdentityPubkey: "02ab",
  })).toBe(false);
  expect(shouldSubscribeNwc({
    destination: null,
    encryptedConnectionSecret: "enc",
  })).toBe(false);
});

Deno.test("POST /users rejects sparkIdentityPubkey", () => {
  expect(
    routeCreateUser({ sparkIdentityPubkey: "02ab", nostrPubkey: "aa" }),
  ).toEqual({
    kind: "error",
    reason:
      "sparkIdentityPubkey is not accepted; register Spark addresses through the signed LNURL register",
    status: 400,
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

Deno.test("POST /users rejects a body that sets both keys", () => {
  expect(routeCreateUser({
    connectionSecret: "nostr+walletconnect://x",
    sparkIdentityPubkey: "02ab",
    nostrPubkey: "aa",
  })).toEqual({
    kind: "error",
    reason:
      "sparkIdentityPubkey is not accepted; register Spark addresses through the signed LNURL register",
    status: 400,
  });
});
