import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { hmac } from "npm:@noble/hashes@1.3.1/hmac";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { nwc } from "npm:@getalby/sdk";
import { createLnurlApp } from "../lnurlp.ts";
import { NWCPool } from "../nwc/nwcPool.ts";
import { createSparkReconciler } from "../spark/reconcile.ts";
import type { SspClient, SspLightningReceive } from "../spark/ssp.ts";
import { createSparkWebhookApp } from "../spark/webhook.ts";
import { makeInvoice } from "../test_bolt11.ts";
import { createSettlementNotifier } from "../settlement-notice.ts";
import { DB, type SettledInvoice } from "./db.ts";

// The settlement notice is sent from the DB's write-once settlement writes, because every path that
// settles an invoice converges there. These tests build a real `DB` with its query builder replaced
// by an in-memory fake (no connection is ever opened) and drive each path through its real entry point.

const PREIMAGE = "ab".repeat(32);
const hashOf = (preimage: string) => bytesToHex(sha256(hexToBytes(preimage)));
const HASH = hashOf(PREIMAGE);
const DESCRIPTION = "Rafting in Mendoza - 3 people | travelsats.ar";
const RECEIVER = "02" + "cd".repeat(32);
const NWC_URL =
  "nostr+walletconnect://b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4?relay=wss%3A%2F%2Frelay.test&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";

type FakeRow = { paymentHash: string; description: string | null; metadata: unknown; settled: boolean };

/** A DB whose `update(...).set(...).where(...).returning(...)` settles a row at most once, like the real conditional UPDATE. */
function dbWithRows(rows: FakeRow[], onFirstSettlement?: (invoice: SettledInvoice) => unknown) {
  const db = new DB("postgresql://u:p@127.0.0.1:1/none", { onFirstSettlement });
  (db as unknown as { _db: unknown })._db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            const row = rows.find((candidate) => !candidate.settled);
            if (!row) return [];
            row.settled = true;
            return [{ id: 1, paymentHash: row.paymentHash, description: row.description, metadata: row.metadata }];
          },
        }),
      }),
    }),
  };
  return db;
}

const freshRow = (over: Partial<FakeRow> = {}): FakeRow => ({
  paymentHash: HASH,
  description: DESCRIPTION,
  metadata: { comment: DESCRIPTION },
  settled: false,
  ...over,
});

const settledTransaction = {
  payment_hash: HASH,
  preimage: PREIMAGE,
  settled_at: 1_700_000_000,
} as unknown as nwc.Nip47Transaction;

// ---- the hook on the write ----

Deno.test("markInvoiceSettled reports whether this call wrote, and notifies once for the first write only", async () => {
  const seen: SettledInvoice[] = [];
  const db = dbWithRows([freshRow()], (invoice) => void seen.push(invoice));
  expect(await db.markInvoiceSettled(3, settledTransaction)).toBe(true);
  expect(await db.markInvoiceSettled(3, settledTransaction)).toBe(false);
  expect(seen).toEqual([{ paymentHash: HASH, description: DESCRIPTION, metadata: { comment: DESCRIPTION } }]);
});

Deno.test("settleSparkInvoice notifies once for the first write only", async () => {
  const seen: SettledInvoice[] = [];
  const db = dbWithRows([freshRow()], (invoice) => void seen.push(invoice));
  expect(await db.settleSparkInvoice(HASH, PREIMAGE)).toBe("settled");
  expect(await db.settleSparkInvoice(HASH, PREIMAGE)).toBe("already_settled");
  expect(seen.length).toBe(1);
  expect(seen[0].paymentHash).toEqual(HASH);
});

Deno.test("a hook that throws or rejects never fails or changes the settlement write", async () => {
  const throwing = dbWithRows([freshRow()], () => {
    throw new Error("hook exploded");
  });
  expect(await throwing.markInvoiceSettled(3, settledTransaction)).toBe(true);

  const rejecting = dbWithRows([freshRow()], () => Promise.reject(new Error("hook rejected")));
  expect(await rejecting.settleSparkInvoice(HASH, PREIMAGE)).toBe("settled");
  // Let the rejected promise settle: it must have been handled, or the test would fail on it.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

Deno.test("a DB without a hook settles exactly as before", async () => {
  const db = dbWithRows([freshRow()]);
  expect(await db.markInvoiceSettled(3, settledTransaction)).toBe(true);
});

// ---- the notifier wired to the hook ----

Deno.test("wired together, a first booking settlement posts one notice, a duplicate none, and a tip none", async () => {
  const posts: string[] = [];
  const notifier = createSettlementNotifier({
    origins: ["https://travelsats.ar"],
    secret: () => "wired-secret",
    fetch: ((_url: string | URL | Request, init?: RequestInit) => {
      posts.push(String(init?.body));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  });
  const pending: Array<Promise<unknown>> = [];
  const hook = (invoice: SettledInvoice) => void pending.push(notifier.notify(invoice));

  const booking = dbWithRows([freshRow()], hook);
  await booking.markInvoiceSettled(3, settledTransaction);
  await booking.markInvoiceSettled(3, settledTransaction);
  const tip = dbWithRows([freshRow({ description: "thanks", metadata: { comment: "thanks" } })], hook);
  await tip.settleSparkInvoice(HASH, PREIMAGE);
  await Promise.all(pending);

  expect(posts).toEqual([`{"payment_hash":"${HASH}"}`]);
});

// ---- the four paths that settle ----

Deno.test("path 1: the NWC payment_received notification triggers the hook once", async () => {
  const seen: SettledInvoice[] = [];
  const db = dbWithRows([freshRow()], (invoice) => void seen.push(invoice));
  let deliver: ((notification: unknown) => Promise<void>) | undefined;
  const pool = new NWCPool(
    db,
    async (secret) => secret,
    () => ({
      subscribeNotifications: (callback: (notification: never) => Promise<void>) => {
        deliver = callback as (notification: unknown) => Promise<void>;
      },
      close: () => undefined,
    }),
  );
  pool.subscribeUser("secret", 5);
  const notification = { notification_type: "payment_received", notification: settledTransaction };
  await deliver!(notification);
  await deliver!(notification);
  expect(seen.map((invoice) => invoice.paymentHash)).toEqual([HASH]);
});

Deno.test("path 2: an NWC lookup done by verify triggers the hook once", async () => {
  const seen: SettledInvoice[] = [];
  const db = dbWithRows([freshRow()], (invoice) => void seen.push(invoice));
  Object.assign(db, {
    findUser: async () => ({
      id: 3,
      username: "bob",
      nostrPubkey: "aa".repeat(32),
      connectionSecret: NWC_URL,
      destination: "nwc",
      sparkIdentityPubkey: null,
    }),
    findInvoice: async () => ({
      userId: 3,
      settledAt: null,
      preimage: null,
      paymentRequest: "lnbc1nwcinvoice",
      paymentHash: HASH,
      mintedBy: "nwc",
      createdAt: new Date(),
    }),
  });
  const original = nwc.NWCClient.prototype.lookupInvoice;
  nwc.NWCClient.prototype.lookupInvoice = async function () {
    return { preimage: PREIMAGE, settled_at: 1_700_000_000, state: "settled" } as unknown as nwc.Nip47Transaction;
  } as typeof nwc.NWCClient.prototype.lookupInvoice;
  try {
    const app = createLnurlApp(db);
    const res = await app.request(`/bob/verify/${HASH}`);
    expect((await res.json()).payment_status).toEqual("paid");
    expect(seen.map((invoice) => invoice.paymentHash)).toEqual([HASH]);
    // A second verify finds the row unsettled in this fake's lookup, but the write is already done: no second notice.
    await app.request(`/bob/verify/${HASH}`);
    expect(seen.length).toBe(1);
  } finally {
    nwc.NWCClient.prototype.lookupInvoice = original;
  }
});

Deno.test("path 3: the Spark webhook triggers the hook once", async () => {
  const seen: SettledInvoice[] = [];
  const db = dbWithRows([freshRow()], (invoice) => void seen.push(invoice));
  Object.assign(db, {
    findInvoiceByPaymentHash: async () => ({ mintedBy: "spark", receiverPubkey: RECEIVER, preimage: null }),
  });
  const secret = "spark-webhook-secret";
  const app = createSparkWebhookApp(db, secret);
  const body = JSON.stringify({
    type: "SPARK_LIGHTNING_RECEIVE_FINISHED",
    payment_preimage: PREIMAGE,
    request_status: "SUCCEEDED",
    status: "TRANSFER_COMPLETED",
    receiver_identity_public_key: RECEIVER,
  });
  const signature = bytesToHex(hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(body)));
  const post = () =>
    app.request("/", { method: "POST", headers: { "Content-Type": "application/json", "X-Spark-Signature": signature }, body });
  expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(200);
  expect(seen.map((invoice) => invoice.paymentHash)).toEqual([HASH]);
});

Deno.test("path 4: the Spark reconcile triggers the hook once", async () => {
  const seen: SettledInvoice[] = [];
  const db = dbWithRows([freshRow()], (invoice) => void seen.push(invoice));
  Object.assign(db, {
    findInvoiceByPaymentHash: async () => ({ mintedBy: "spark", receiverPubkey: RECEIVER, preimage: null }),
  });
  const nowMs = Date.parse("2026-10-04T16:00:00Z");
  const mintedMs = nowMs - 120_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const record: SspLightningReceive = {
    id: "SparkLightningReceiveRequest:1",
    created_at: iso(mintedMs),
    updated_at: iso(mintedMs + 30_000),
    request_status: "SUCCEEDED",
    status: "TRANSFER_COMPLETED",
    payment_preimage: PREIMAGE,
    receiver_identity_public_key: RECEIVER,
    invoice: { payment_hash: HASH, created_at: iso(mintedMs), expires_at: iso(mintedMs + 300_000) },
  };
  const ssp: SspClient = {
    listLightningReceives: async () => ({ entries: [record], hasNextPage: false, endCursor: null }),
  };
  const reconcile = createSparkReconciler({ ssp, db, now: () => new Date(nowMs) });
  const invoice = {
    paymentHash: HASH,
    paymentRequest: makeInvoice({ paymentHash: HASH, timestamp: Math.floor(mintedMs / 1000), expirySecs: 300 }),
    createdAt: new Date(mintedMs),
  };
  expect((await reconcile(invoice)).kind).toEqual("paid");
  // A second reconcile within the throttle window may be skipped; either way no second notice.
  await reconcile(invoice);
  expect(seen.map((entry) => entry.paymentHash)).toEqual([HASH]);
});
