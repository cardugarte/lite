import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "./db/db.ts";
import type { NWCPool } from "./nwc/nwcPool.ts";
import { buildApp } from "./app.ts";

const ORIGIN = "https://dev.travelsats.ar";

function app() {
  const db = {
    findUser: async (username: string) => ({
      id: 1,
      username,
      nostrPubkey: "aa".repeat(32),
      connectionSecret: null,
      destination: "spark",
      sparkIdentityPubkey: "02" + "ab".repeat(32),
    }),
  } as unknown as DB;
  return buildApp({
    db,
    nwcPool: {} as NWCPool,
    sparkWebhookSecret: "test-webhook-secret",
  });
}

function preflight(path: string) {
  return app().request(path, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
    },
  });
}

Deno.test("secret and webhook prefixes do not emit Access-Control-Allow-Origin", async () => {
  for (const path of ["/users", "/users/binding-intents", "/users/nwc-bind", "/spark/webhook"]) {
    const res = await preflight(path);
    expect({ path, allowOrigin: res.headers.get("Access-Control-Allow-Origin") }).toEqual({
      path,
      allowOrigin: null,
    });
  }
});

Deno.test("public LNURL prefixes allow any origin", async () => {
  const paths = [
    "/.well-known/lnurlp/alice",
    "/lnurlp/alice/callback?amount=1000",
    "/.well-known/nostr.json?name=alice",
  ];
  for (const path of paths) {
    const res = await app().request(path, {
      headers: { Origin: "https://example.org" },
    });
    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    expect({ path, present: allowOrigin !== null && allowOrigin !== "" }).toEqual({
      path,
      present: true,
    });
  }
});
