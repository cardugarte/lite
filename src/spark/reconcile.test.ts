import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import type { DB } from "../db/db.ts";
import { makeInvoice } from "../test_bolt11.ts";
import { captureLogs, entriesFor } from "../test_logs.ts";
import { createSparkReconciler, type SparkReconcileOutcome } from "./reconcile.ts";
import { type SspClient, SspError, type SspLightningReceive, type SspPage } from "./ssp.ts";

/** The payment hash a preimage proves, computed here and not by the code under test. */
const hashOf = (preimage: string) => bytesToHex(sha256(hexToBytes(preimage)));
const PREIMAGE = "ab".repeat(32);
const HASH = hashOf(PREIMAGE);
const OTHER_PREIMAGE = "cd".repeat(32);
const OTHER_HASH = hashOf(OTHER_PREIMAGE);
const RECEIVER = "02" + "cd".repeat(32);

const T0 = Date.parse("2026-10-04T16:00:00Z");
const MINTED_MS = T0 - 120_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ---- SSP records, in the shapes observed on mainnet ----

const unpaidRecord = (hash = HASH, createdMs = MINTED_MS): SspLightningReceive => ({
  id: `SparkLightningReceiveRequest:${hash.slice(0, 8)}`,
  created_at: iso(createdMs),
  updated_at: iso(createdMs),
  request_status: "CREATED",
  status: "INVOICE_CREATED",
  payment_preimage: null,
  receiver_identity_public_key: null,
  invoice: { payment_hash: hash, created_at: iso(createdMs), expires_at: iso(createdMs + 300_000) },
});

const paidRecord = (over: Partial<SspLightningReceive> = {}, hash = HASH, createdMs = MINTED_MS): SspLightningReceive => ({
  ...unpaidRecord(hash, createdMs),
  updated_at: iso(createdMs + 30_000),
  request_status: "SUCCEEDED",
  status: "TRANSFER_COMPLETED",
  payment_preimage: PREIMAGE,
  receiver_identity_public_key: RECEIVER,
  ...over,
});

const page = (entries: SspLightningReceive[], next?: string): SspPage => ({
  entries,
  hasNextPage: next !== undefined,
  endCursor: next ?? null,
});

// ---- the invoice Lite holds ----

const stored = (over: Partial<{ paymentHash: string; paymentRequest: string; createdAt: Date }> = {}) => ({
  paymentHash: HASH,
  paymentRequest: makeInvoice({ paymentHash: HASH, timestamp: Math.floor(MINTED_MS / 1000), expirySecs: 300 }),
  createdAt: new Date(MINTED_MS),
  ...over,
});

type Row = { mintedBy: string; receiverPubkey: string | null; preimage: string | null };

function harness(options: {
  /** Served in order, one per list call; an Error is thrown. After the last one, empty pages. */
  pages?: Array<SspPage | Error>;
  rows?: Array<[string, Row]>;
  failures?: { read?: boolean; write?: boolean };
  gate?: Promise<void>;
  reconciler?: Partial<Parameters<typeof createSparkReconciler>[0]>;
} = {}) {
  const lists: Array<{ first?: number; after?: string }> = [];
  const reads: string[] = [];
  const writes: Array<{ paymentHash: string; preimage: string; settledAt: Date }> = [];
  const rows = new Map<string, Row>(
    options.rows ?? [[HASH, { mintedBy: "spark", receiverPubkey: RECEIVER, preimage: null }]],
  );
  let clock = T0;

  // Anything else on either fake is undefined and fails the test: the reconciler may use only these.
  const ssp: SspClient = {
    listLightningReceives: async (args) => {
      lists.push({ ...args });
      await options.gate;
      const next = options.pages?.[lists.length - 1];
      if (next instanceof Error) throw next;
      return next ?? page([]);
    },
  };
  const db = {
    findInvoiceByPaymentHash: async (hash: string) => {
      reads.push(hash);
      if (options.failures?.read) throw new Error("connection refused");
      return rows.get(hash) ?? null;
    },
    settleSparkInvoice: async (paymentHash: string, preimage: string, settledAt: Date) => {
      if (options.failures?.write) throw new Error("disk full");
      const row = rows.get(paymentHash);
      if (!row || row.mintedBy !== "spark" || row.preimage !== null) return "already_settled";
      row.preimage = preimage;
      writes.push({ paymentHash, preimage, settledAt });
      return "settled";
    },
  } as unknown as DB;

  const reconcile = createSparkReconciler({ ssp, db, now: () => new Date(clock), ...options.reconciler });
  return { reconcile, lists, reads, writes, rows, advance: (ms: number) => void (clock += ms) };
}

const PAID: SparkReconcileOutcome = { kind: "paid", preimage: PREIMAGE };
const UNPAID: SparkReconcileOutcome = { kind: "unpaid" };
const UNKNOWN: SparkReconcileOutcome = { kind: "unknown" };

// ---- settling from the SSP record: the webhook's rule ----

Deno.test("a succeeded, completed record whose preimage hashes to the invoice settles it, once, with Lite's clock", async () => {
  const h = harness({ pages: [page([unpaidRecord("11".repeat(32)), paidRecord()])] });
  const { result, entries, raw } = await captureLogs(() => h.reconcile(stored()));
  expect(result).toEqual(PAID);
  expect(h.writes).toEqual([{ paymentHash: HASH, preimage: PREIMAGE, settledAt: new Date(T0) }]);
  const reconciled = entriesFor(entries, "spark_settlement_reconciled");
  expect(reconciled.length).toEqual(1);
  expect(reconciled[0].level).toEqual("INFO");
  expect(reconciled[0].args?.payment_hash).toEqual(HASH);
  expect(raw).not.toContain(PREIMAGE);
});

Deno.test("a webhook that won the race is not an error: the invoice is paid and nothing is written twice", async () => {
  const h = harness({
    pages: [page([paidRecord()])],
    rows: [[HASH, { mintedBy: "spark", receiverPubkey: RECEIVER, preimage: PREIMAGE }]],
  });
  expect(await h.reconcile(stored())).toEqual(PAID);
  expect(h.writes).toEqual([]);
});

Deno.test("a record that is not both SUCCEEDED and TRANSFER_COMPLETED settles nothing and is not a warning", async () => {
  const records = [
    unpaidRecord(),
    paidRecord({ status: "INVOICE_CREATED" }),
    paidRecord({ request_status: "CREATED" }),
    paidRecord({ request_status: "FAILED" }),
    paidRecord({ status: null }),
  ];
  for (const record of records) {
    const h = harness({ pages: [page([record])] });
    const { result, entries } = await captureLogs(() => h.reconcile(stored()));
    expect({ status: record.status, request: record.request_status, result }).toEqual({
      status: record.status,
      request: record.request_status,
      result: UNPAID,
    });
    expect(h.writes).toEqual([]);
    expect(entries.filter((entry) => entry.level === "WARN" || entry.level === "ERROR")).toEqual([]);
  }
});

Deno.test("a preimage that is missing or not 32 bytes of hex settles nothing and logs a warning without it", async () => {
  for (const payment_preimage of [null, "", "not-hex", "ab".repeat(31)]) {
    const h = harness({ pages: [page([paidRecord({ payment_preimage })])] });
    const { result, entries } = await captureLogs(() => h.reconcile(stored()));
    expect({ payment_preimage, result }).toEqual({ payment_preimage, result: UNPAID });
    expect(h.writes).toEqual([]);
    expect(entries.some((entry) => entry.level === "WARN")).toEqual(true);
  }
});

Deno.test("a preimage that hashes to another invoice settles neither", async () => {
  // The SSP record is listed under HASH but carries the preimage of OTHER_HASH.
  const h = harness({
    pages: [page([paidRecord({ payment_preimage: OTHER_PREIMAGE })])],
    rows: [
      [HASH, { mintedBy: "spark", receiverPubkey: RECEIVER, preimage: null }],
      [OTHER_HASH, { mintedBy: "spark", receiverPubkey: RECEIVER, preimage: null }],
    ],
  });
  const { result, entries, raw } = await captureLogs(() => h.reconcile(stored()));
  expect(result).toEqual(UNPAID);
  expect(h.writes).toEqual([]);
  expect(h.rows.get(OTHER_HASH)?.preimage).toBeNull();
  const mismatch = entriesFor(entries, "spark_reconcile_hash_mismatch");
  expect(mismatch.length).toEqual(1);
  expect(mismatch[0].args?.payment_hash).toEqual(HASH);
  expect(raw).not.toContain(OTHER_PREIMAGE);
});

Deno.test("a receiver key that differs settles nothing; an absent key settles with a warning, as the webhook does", async () => {
  const wrongKey = harness({ pages: [page([paidRecord({ receiver_identity_public_key: "03" + "ee".repeat(32) })])] });
  const wrong = await captureLogs(() => wrongKey.reconcile(stored()));
  expect(wrong.result).toEqual(UNPAID);
  expect(wrongKey.writes).toEqual([]);
  expect(entriesFor(wrong.entries, "spark_webhook_receiver_mismatch").length).toEqual(1);

  const upper = harness({ pages: [page([paidRecord({ receiver_identity_public_key: RECEIVER.toUpperCase() })])] });
  expect((await upper.reconcile(stored())).kind).toEqual("paid");

  const noKey = harness({ pages: [page([paidRecord({ receiver_identity_public_key: null })])] });
  const absent = await captureLogs(() => noKey.reconcile(stored()));
  expect(absent.result).toEqual(PAID);
  expect(entriesFor(absent.entries, "spark_webhook_receiver_key_absent").length).toEqual(1);
});

Deno.test("an invoice that is not Spark-minted is never settled from the SSP list", async () => {
  const h = harness({
    pages: [page([paidRecord()])],
    rows: [[HASH, { mintedBy: "nwc", receiverPubkey: null, preimage: null }]],
  });
  expect(await h.reconcile(stored())).toEqual(UNPAID);
  expect(h.writes).toEqual([]);
});

Deno.test("the hash is matched case-insensitively", async () => {
  const h = harness({ pages: [page([paidRecord({ invoice: { ...paidRecord().invoice, payment_hash: HASH.toUpperCase() } })])] });
  expect((await h.reconcile(stored())).kind).toEqual("paid");
});

// ---- scanning the list ----

Deno.test("an invoice the SSP lists as unpaid is unpaid", async () => {
  const h = harness({ pages: [page([unpaidRecord()])] });
  expect(await h.reconcile(stored())).toEqual(UNPAID);
  expect(h.lists).toEqual([{ first: 100, after: undefined }]);
});

Deno.test("an invoice that is on no page of a list that ends is unpaid", async () => {
  const h = harness({ pages: [page([unpaidRecord("11".repeat(32))])] });
  expect(await h.reconcile(stored())).toEqual(UNPAID);
});

Deno.test("the scan goes back page by page until the hash is found", async () => {
  const h = harness({
    pages: [
      page([unpaidRecord("11".repeat(32), T0 - 10_000)], "cursor-1"),
      page([unpaidRecord("22".repeat(32), T0 - 60_000)], "cursor-2"),
      page([paidRecord()]),
    ],
  });
  expect(await h.reconcile(stored())).toEqual(PAID);
  expect(h.lists).toEqual([
    { first: 100, after: undefined },
    { first: 100, after: "cursor-1" },
    { first: 100, after: "cursor-2" },
  ]);
});

Deno.test("the scan stops once a page reaches entries older than the invoice's creation minus an hour", async () => {
  const hour = 3_600_000;
  const h = harness({
    pages: [
      page([unpaidRecord("11".repeat(32), T0 - 10_000)], "cursor-1"),
      // Created before MINTED_MS - 1 h: nothing further back can be this invoice.
      page([unpaidRecord("22".repeat(32), MINTED_MS - hour - 1_000)], "cursor-2"),
      page([paidRecord()]),
    ],
  });
  expect(await h.reconcile(stored())).toEqual(UNPAID);
  expect(h.lists.length).toEqual(2);
});

Deno.test("an entry exactly an hour before the invoice's creation does not stop the scan", async () => {
  const hour = 3_600_000;
  const h = harness({
    pages: [page([unpaidRecord("11".repeat(32), MINTED_MS - hour)], "cursor-1"), page([paidRecord()])],
  });
  expect(await h.reconcile(stored())).toEqual(PAID);
});

Deno.test("the floor follows the earlier of the BOLT11 timestamp and the row's creation time", async () => {
  const minute = 60_000;
  // A row whose creation time is three hours off, as a database in another time zone would write it.
  // Either way the scan must reach the paid record on page two.
  const cases: Array<{ rowSkewMs: number; entryAgeMs: number; why: string }> = [
    // Row later than the invoice: a row-based floor (mint + 2 h) would stop at the 30-minute-old entry.
    { rowSkewMs: 180 * minute, entryAgeMs: 30 * minute, why: "the BOLT11 timestamp is the earlier anchor" },
    // Row earlier than the invoice: a BOLT11-based floor (mint - 1 h) would stop at the 90-minute-old entry.
    { rowSkewMs: -180 * minute, entryAgeMs: 90 * minute, why: "the row is the earlier anchor" },
  ];
  for (const { rowSkewMs, entryAgeMs, why } of cases) {
    const h = harness({
      pages: [page([unpaidRecord("11".repeat(32), MINTED_MS - entryAgeMs)], "cursor-1"), page([paidRecord()])],
    });
    const outcome = await h.reconcile(stored({ createdAt: new Date(MINTED_MS + rowSkewMs) }));
    expect({ why, kind: outcome.kind }).toEqual({ why, kind: "paid" });
  }
});

Deno.test("a payment request that cannot be decoded falls back to the row's creation time", async () => {
  const hour = 3_600_000;
  const h = harness({
    pages: [page([unpaidRecord("11".repeat(32), MINTED_MS - hour - 1_000)], "cursor-1"), page([paidRecord()])],
  });
  expect(await h.reconcile(stored({ paymentRequest: "lnbc1sparkinvoice" }))).toEqual(UNPAID);
  expect(h.lists.length).toEqual(1);
});

Deno.test("a scan that runs out of pages without an answer is unknown, not unpaid", async () => {
  const pages = Array.from({ length: 4 }, (_, i) => page([unpaidRecord(`${i}`.repeat(64).slice(0, 64), T0 - 10_000)], `cursor-${i + 1}`));
  const h = harness({ pages, reconciler: { maxPages: 3 } });
  expect(await h.reconcile(stored())).toEqual(UNKNOWN);
  expect(h.lists.length).toEqual(3);
});

Deno.test("a next page that cannot be reached because the cursor is missing is unknown", async () => {
  const h = harness({ pages: [{ entries: [unpaidRecord("11".repeat(32), T0 - 10_000)], hasNextPage: true, endCursor: null }] });
  expect(await h.reconcile(stored())).toEqual(UNKNOWN);
});

Deno.test("the page size is asked for, and entries without a readable date do not end the scan", async () => {
  const noDate = { ...unpaidRecord("11".repeat(32)), created_at: null };
  const h = harness({ pages: [page([noDate], "cursor-1"), page([paidRecord()])], reconciler: { pageSize: 25 } });
  expect(await h.reconcile(stored())).toEqual(PAID);
  expect(h.lists.map((list) => list.first)).toEqual([25, 25]);
});

// ---- when the answer cannot be learned ----

Deno.test("an SSP that fails is unknown, logged without secrets, and nothing is written", async () => {
  const errors: Error[] = [
    new SspError("SSP request failed", "network"),
    new SspError("SSP answered HTTP 503", "http", 503),
    new SspError("SSP refused the session (HTTP 401)", "auth", 401),
    new Error("wasm failed to load"),
  ];
  for (const error of errors) {
    const h = harness({ pages: [error] });
    const { result, entries, raw } = await captureLogs(() => h.reconcile(stored()));
    expect({ error: error.message, result }).toEqual({ error: error.message, result: UNKNOWN });
    expect(h.writes).toEqual([]);
    const failed = entriesFor(entries, "spark_reconcile_failed");
    expect(failed.length).toEqual(1);
    expect(failed[0].level).toEqual("WARN");
    expect(failed[0].args?.errorName).toEqual(error.name);
    expect(failed[0].args?.payment_hash).toEqual(HASH);
    if (error instanceof SspError) {
      expect(failed[0].args?.kind).toEqual(error.kind);
      expect(failed[0].args?.http_status).toEqual(error.status);
    }
    expect(raw).not.toContain(PREIMAGE);
  }
});

Deno.test("a database that fails, on the read or on the write, is unknown", async () => {
  for (const failures of [{ read: true }, { write: true }]) {
    const h = harness({ pages: [page([paidRecord()])], failures });
    const { result, entries } = await captureLogs(() => h.reconcile(stored()));
    expect({ failures, result }).toEqual({ failures, result: UNKNOWN });
    expect(entriesFor(entries, "spark_reconcile_failed").length).toEqual(1);
    expect(h.writes).toEqual([]);
  }
});

Deno.test("failures are logged at most once a minute, with a count of what was held back", async () => {
  const error = new SspError("SSP request failed", "network");
  const h = harness({ pages: new Array(10).fill(error) });
  const hashes = Array.from({ length: 4 }, (_, i) => `${i + 1}`.repeat(64).slice(0, 64));
  const { entries } = await captureLogs(async () => {
    await h.reconcile(stored({ paymentHash: hashes[0] })); // logged
    h.advance(10_000);
    await h.reconcile(stored({ paymentHash: hashes[1] })); // held back
    await h.reconcile(stored({ paymentHash: hashes[2] })); // held back
    h.advance(60_000);
    await h.reconcile(stored({ paymentHash: hashes[3] })); // logged, with the count
  });
  const failed = entriesFor(entries, "spark_reconcile_failed");
  expect(failed.map((entry) => entry.args?.suppressed ?? 0)).toEqual([0, 2]);
});

// ---- one lookup per hash, with a throttle ----

Deno.test("concurrent lookups of one hash share a single SSP call and one answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = harness({ pages: [page([paidRecord()])], gate });
  const calls = Array.from({ length: 5 }, () => h.reconcile(stored()));
  release();
  expect(await Promise.all(calls)).toEqual(new Array(5).fill(PAID));
  expect(h.lists.length).toEqual(1);
  expect(h.writes.length).toEqual(1);
});

Deno.test("a lookup that finished less than five seconds ago is answered again without asking the SSP", async () => {
  const h = harness({ pages: [page([unpaidRecord()]), page([paidRecord()])] });
  expect(await h.reconcile(stored())).toEqual(UNPAID);
  h.advance(4_999);
  expect(await h.reconcile(stored())).toEqual(UNPAID);
  expect(h.lists.length).toEqual(1);

  h.advance(1);
  expect(await h.reconcile(stored())).toEqual(PAID);
  expect(h.lists.length).toEqual(2);
});

Deno.test("the throttle holds for an unknown answer too, so a struggling SSP is not hammered", async () => {
  const h = harness({ pages: [new SspError("SSP request failed", "network"), page([paidRecord()])] });
  const { result: first } = await captureLogs(() => h.reconcile(stored()));
  expect(first).toEqual(UNKNOWN);
  h.advance(2_000);
  expect(await h.reconcile(stored())).toEqual(UNKNOWN);
  expect(h.lists.length).toEqual(1);
  h.advance(3_000);
  expect(await h.reconcile(stored())).toEqual(PAID);
});

Deno.test("hashes are throttled one by one", async () => {
  const h = harness({ pages: [page([unpaidRecord()]), page([unpaidRecord(OTHER_HASH)])] });
  expect(await h.reconcile(stored())).toEqual(UNPAID);
  expect(await h.reconcile(stored({ paymentHash: OTHER_HASH }))).toEqual(UNPAID);
  expect(h.lists.length).toEqual(2);
});

Deno.test("the throttle keeps at most trackedLimit hashes and forgets the oldest first", async () => {
  const h = harness({ reconciler: { trackedLimit: 2 } });
  const hashes = ["1", "2", "3"].map((digit) => digit.repeat(64));
  for (const paymentHash of hashes) await h.reconcile(stored({ paymentHash }));
  expect(h.lists.length).toEqual(3);
  // "1" fell out of the memory, so it is looked up again; "3" is still remembered.
  await h.reconcile(stored({ paymentHash: hashes[2] }));
  expect(h.lists.length).toEqual(3);
  await h.reconcile(stored({ paymentHash: hashes[0] }));
  expect(h.lists.length).toEqual(4);
});

Deno.test("main.ts builds the reconciler only where the minter exists, from the minter mnemonic, and hands it to the app", () => {
  const main = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
  expect(main).toMatch(/const sparkReconciler = sparkMinter\s*\?\s*createSparkReconciler\(/);
  expect(main).toContain("createBreezIdentitySigner({ mnemonic: SPARK_MINTER_MNEMONIC })");
  expect(main).toMatch(/buildApp\(\{[^}]*sparkReconciler[^}]*\}\)/);
});
