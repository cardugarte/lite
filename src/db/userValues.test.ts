import { expect } from "jsr:@std/expect";
import { nwc } from "npm:@getalby/sdk";
import {
  buildSparkUserValues,
  parseNwcConnectionSecret,
} from "./userValues.ts";

const NWC_URL =
  "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";

const SPARK_PUBKEY =
  "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

Deno.test("createSparkUser does not store a spendable NWC secret", () => {
  const values = buildSparkUserValues({
    sparkIdentityPubkey: SPARK_PUBKEY,
    username: "alice",
    nostrPubkey: "aa".repeat(32),
  });

  expect(values.encryptedConnectionSecret).toBeNull();
  expect(values.destination).toEqual("spark");
  expect(values.sparkIdentityPubkey).toEqual(SPARK_PUBKEY);
  expect(values.username).toEqual("alice");
  expect(values.nostrPubkey).toEqual("aa".repeat(32));
});

Deno.test("createSparkUser rejects a missing spark identity pubkey", () => {
  expect(() =>
    buildSparkUserValues({
      sparkIdentityPubkey: "",
      username: "alice",
    })
  ).toThrow("no spark identity pubkey provided");
});

Deno.test("createSparkUser rejects a non-compressed spark identity pubkey", () => {
  expect(() =>
    buildSparkUserValues({
      sparkIdentityPubkey: "not-a-key",
      username: "alice",
    })
  ).toThrow(/compressed secp256k1/i);
});

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
