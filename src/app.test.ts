import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "./db/db.ts";
import type { NWCPool } from "./nwc/nwcPool.ts";
import { secp256k1 } from "npm:@noble/curves@1.2.0/secp256k1";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { utf8ToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { buildApp } from "./app.ts";
import { INVOICE_EXPIRY_SECS } from "./constants.ts";

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

// ---------------------------------------------------------------------------
// /lnurlpay: CORS first, then the 4 KiB cap, then the routes.
// ---------------------------------------------------------------------------

const LNURL_DOMAIN = "lite-dev.travelsats.ar";
const NOW_S = 1_700_000_000;
const KEY = new Uint8Array(32).fill(0x11);
const PUBKEY = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const FOUR_KIB = 4096;
const observedStatuses: number[] = [];

function lnurlpayApp(origins?: string[]) {
  const dbCalls: string[] = [];
  const db = {
    findUser: async () => {
      throw new Error("user not found");
    },
    findUserBySparkPubkey: async () => {
      dbCalls.push("findUserBySparkPubkey");
      return null;
    },
  } as unknown as DB;
  const hono = buildApp({
    db,
    nwcPool: {} as NWCPool,
    sparkWebhookSecret: "test-webhook-secret",
    appOrigins: origins,
    lnurlDomain: LNURL_DOMAIN,
    now: () => new Date(NOW_S * 1000),
  });
  return { hono, dbCalls };
}

function recoverBody(pad = 0): string {
  const message = `breez-lnurl:v2\nrecover\n${LNURL_DOMAIN}\n${PUBKEY}\n${NOW_S}`;
  const signature = secp256k1.sign(sha256(utf8ToBytes(message)), KEY).toDERHex();
  return JSON.stringify({ signature, timestamp: NOW_S, ...(pad > 0 ? { pad: "x".repeat(pad) } : {}) });
}

/** A valid recover body whose UTF-8 length is exactly `bytes`. */
function recoverBodyOfSize(bytes: number): string {
  const base = new TextEncoder().encode(recoverBody()).length;
  // Adding the key costs `,"pad":""` (9 bytes) plus the padding itself.
  const body = recoverBody(bytes - base - 9);
  expect(new TextEncoder().encode(body).length).toEqual(bytes);
  return body;
}

async function lnurlpayRequest(
  hono: ReturnType<typeof buildApp>,
  path: string,
  init: RequestInit,
) {
  const res = await hono.request(path, init);
  observedStatuses.push(res.status);
  return res;
}

Deno.test("a preflight to /lnurlpay is answered before any body handling", async () => {
  const { hono, dbCalls } = lnurlpayApp([ORIGIN]);
  const res = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
  });
  expect(res.status).toEqual(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toEqual(ORIGIN);
  expect(dbCalls).toEqual([]);
});

Deno.test("an oversized POST from a listed origin is 413 with allow-origin and no database call", async () => {
  const { hono, dbCalls } = lnurlpayApp([ORIGIN]);
  const body = recoverBody(5 * 1024);
  for (const withLength of [true, false]) {
    const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json" };
    if (withLength) headers["Content-Length"] = String(new TextEncoder().encode(body).length);
    const res = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}/recover`, { method: "POST", headers, body });
    expect({ withLength, status: res.status }).toEqual({ withLength, status: 413 });
    expect(await res.json()).toEqual("payload too large");
    expect(res.headers.get("Access-Control-Allow-Origin")).toEqual(ORIGIN);
  }
  expect(dbCalls).toEqual([]);
});

Deno.test("a valid body of exactly 4096 bytes passes the cap and one byte more does not", async () => {
  const { hono, dbCalls } = lnurlpayApp([ORIGIN]);
  const exact = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}/recover`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: recoverBodyOfSize(FOUR_KIB),
  });
  expect(exact.status).toEqual(404);
  expect(await exact.json()).toEqual("user not found");
  expect(dbCalls).toEqual(["findUserBySparkPubkey"]);

  const over = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}/recover`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: recoverBodyOfSize(FOUR_KIB + 1),
  });
  expect(over.status).toEqual(413);
  expect(dbCalls).toEqual(["findUserBySparkPubkey"]);
});

Deno.test("a listed origin gets allow-origin on real responses and a foreign origin gets none", async () => {
  const { hono } = lnurlpayApp([ORIGIN]);
  const listed = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}/recover`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: recoverBody(),
  });
  expect(listed.headers.get("Access-Control-Allow-Origin")).toEqual(ORIGIN);
  const foreign = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}/recover`, {
    method: "POST",
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    body: recoverBody(),
  });
  expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

Deno.test("without appOrigins the BASE_URL origin is the only allowed app origin", async () => {
  const { hono } = lnurlpayApp(undefined);
  const baseOrigin = new URL(Deno.env.get("BASE_URL")!).origin;
  const own = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}`, {
    method: "OPTIONS",
    headers: { Origin: baseOrigin, "Access-Control-Request-Method": "POST" },
  });
  expect(own.headers.get("Access-Control-Allow-Origin")).toEqual(baseOrigin);
  const other = await lnurlpayRequest(hono, `/lnurlpay/${PUBKEY}`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
  });
  expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

Deno.test("there is no GET /lnurlp/{user} route, and /users and the webhook still carry no CORS headers", async () => {
  const { hono } = lnurlpayApp([ORIGIN]);
  const lnurlp = await hono.request("/lnurlp/alice", { headers: { Origin: ORIGIN } });
  expect(lnurlp.status).toEqual(404);
  for (const [path, method] of [["/users", "POST"], ["/users/binding-intents", "POST"], ["/spark/webhook", "POST"]]) {
    const res = await hono.request(path, {
      method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect({ path, allowOrigin: res.headers.get("Access-Control-Allow-Origin") }).toEqual({ path, allowOrigin: null });
  }
});

Deno.test("every /lnurlpay status observed in this file is in the closed set", () => {
  const allowed = new Set([200, 204, 400, 403, 404, 409, 413, 500]);
  expect(observedStatuses.length).toBeGreaterThan(8);
  expect([...new Set(observedStatuses)].filter((status) => !allowed.has(status))).toEqual([]);
});

Deno.test("buildApp hands the invoice expiry to the mint path, and defaults to the setting", async () => {
  const seen: number[] = [];
  const db = {
    findUser: async () => ({
      id: 1,
      username: "alice",
      nostrPubkey: "aa".repeat(32),
      connectionSecret: null,
      destination: "spark",
      sparkIdentityPubkey: "02" + "ab".repeat(32),
    }),
    createInvoice: async () => {},
  } as unknown as DB;
  const sparkMinter = {
    createInvoice: async (input: { expirySecs: number }) => {
      seen.push(input.expirySecs);
      return { invoice: "lnbc1x", paymentHash: "ee".repeat(32), receiverPubkey: "02" + "ab".repeat(32) };
    },
  };
  const build = (invoiceExpirySecs?: number) =>
    buildApp({ db, nwcPool: {} as NWCPool, sparkMinter, sparkWebhookSecret: "s", invoiceExpirySecs });
  await build(90).request("/lnurlp/alice/callback?amount=1000000");
  await build().request("/lnurlp/alice/callback?amount=1000000");
  expect(seen).toEqual([90, INVOICE_EXPIRY_SECS]);
});
