import "./../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { hmac } from "npm:@noble/hashes@1.3.1/hmac";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import type { DB } from "../db/db.ts";
import { logger } from "../logger.ts";
import { createSparkWebhookApp, resetSparkWebhookLogState } from "./webhook.ts";

const SECRET = "spark-webhook-secret";
const PREIMAGE = "ab".repeat(32);
const OTHER_PREIMAGE = "cd".repeat(32);
const hashOf = (preimage: string) => bytesToHex(sha256(hexToBytes(preimage)));
const PAYMENT_HASH = hashOf(PREIMAGE);
const KEY = "02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const T1 = new Date("2026-03-10T10:00:00.000Z");
const T2 = new Date("2026-03-10T10:05:00.000Z");

const completed = {
  type: "SPARK_LIGHTNING_RECEIVE_FINISHED",
  payment_preimage: PREIMAGE,
  request_status: "SUCCEEDED",
  status: "TRANSFER_COMPLETED",
  receiver_identity_public_key: KEY,
  timestamp: "2001-01-01T00:00:00Z",
};

function sign(body: string): string {
  return bytesToHex(
    hmac(sha256, new TextEncoder().encode(SECRET), new TextEncoder().encode(body)),
  );
}

type Invoice = { mintedBy: string; receiverPubkey: string | null; preimage: string | null };

type Harness = {
  db: DB;
  writes: Array<{ paymentHash: string; preimage: string; settledAt: Date }>;
  lookups: string[];
  invoices: Map<string, Invoice>;
};

function harness(
  invoices: Array<[string, Invoice]> = [[PAYMENT_HASH, { mintedBy: "spark", receiverPubkey: KEY, preimage: null }]],
  failures: { lookup?: boolean; write?: boolean } = {},
): Harness {
  const map = new Map(invoices);
  const writes: Harness["writes"] = [];
  const lookups: string[] = [];
  const db = {
    findInvoiceByPaymentHash: async (hash: string) => {
      lookups.push(hash);
      if (failures.lookup) throw new Error("connection refused");
      return map.get(hash) ?? null;
    },
    settleSparkInvoice: async (paymentHash: string, preimage: string, settledAt: Date) => {
      if (failures.write) throw new Error("disk full");
      const invoice = map.get(paymentHash);
      if (!invoice || invoice.mintedBy !== "spark" || invoice.preimage !== null) return "already_settled";
      invoice.preimage = preimage;
      writes.push({ paymentHash, preimage, settledAt });
      return "settled";
    },
  } as unknown as DB;
  return { db, writes, lookups, invoices: map };
}

type LogEntry = { level: string; message: string; args?: Record<string, unknown> };

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; entries: LogEntry[]; raw: string }> {
  const writable = logger as unknown as { levelName: string; handlers: Array<{ levelName: string }> };
  const previousLevel = writable.levelName;
  const previousHandlers = writable.handlers.map((handler) => handler.levelName);
  writable.levelName = "DEBUG";
  for (const handler of writable.handlers) handler.levelName = "DEBUG";
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  try {
    const result = await fn();
    const entries: LogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Not a structured entry.
      }
    }
    return { result, entries, raw: lines.join("\n") };
  } finally {
    console.log = original;
    writable.levelName = previousLevel;
    writable.handlers.forEach((handler, index) => {
      handler.levelName = previousHandlers[index];
    });
  }
}

const events = (entries: LogEntry[]) => entries.map((entry) => entry.args?.event).filter(Boolean);

async function deliver(
  h: Harness,
  payload: unknown,
  options: { now?: Date; signature?: string | null; raw?: string } = {},
) {
  const app = createSparkWebhookApp(h.db, SECRET, () => options.now ?? T1);
  const body = options.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.signature !== null) headers["X-Spark-Signature"] = options.signature ?? sign(body);
  const res = await app.request("/", { method: "POST", headers, body });
  return { res, json: await res.json() };
}

Deno.test("an invalid or missing HMAC is 401 and writes and reads nothing", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  for (const signature of ["00".repeat(32), "not-hex", null]) {
    const { res } = await deliver(h, completed, { signature });
    expect(res.status).toEqual(401);
  }
  expect(h.writes).toEqual([]);
  expect(h.lookups).toEqual([]);
});

Deno.test("a body that is not JSON is 400", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const { res, json } = await deliver(h, undefined, { raw: "not json" });
  expect(res.status).toEqual(400);
  expect(json).toEqual({ status: "ERROR", reason: "invalid json" });
  expect(h.writes).toEqual([]);
});

Deno.test("a non-matching event type is acknowledged and nothing is written", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const { res, json } = await deliver(h, { ...completed, type: "SPARK_OTHER_EVENT" });
  expect(res.status).toEqual(200);
  expect(json).toEqual({ status: "OK" });
  expect(h.writes).toEqual([]);
  expect(h.lookups).toEqual([]);
});

Deno.test("a completed transfer settles with settled_at from the server clock, not the payload timestamp", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const { res, json } = await deliver(h, completed, { now: T1 });
  expect(res.status).toEqual(200);
  expect(json).toEqual({ status: "OK" });
  expect(h.writes).toEqual([{ paymentHash: PAYMENT_HASH, preimage: PREIMAGE, settledAt: T1 }]);
});

Deno.test("a 0x-prefixed uppercase preimage is stored lowercase without the prefix", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  await deliver(h, { ...completed, payment_preimage: "0x" + PREIMAGE.toUpperCase() });
  expect(h.writes.map((write) => write.preimage)).toEqual([PREIMAGE]);
});

Deno.test("absent status fields are a retryable 503 with the status_absent event and never a non_success", async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...completed, request_status: undefined },
    { ...completed, status: undefined },
    { ...completed, request_status: null },
    { ...completed, request_status: undefined, status: undefined },
  ];
  for (const payload of cases) {
    resetSparkWebhookLogState();
    const h = harness();
    const { result, entries, raw } = await captureLogs(() => deliver(h, payload));
    expect(result.res.status).toEqual(503);
    expect(result.json).toEqual({ status: "ERROR", reason: "status fields missing" });
    expect(h.writes).toEqual([]);
    expect(h.lookups).toEqual([]);
    expect(events(entries)).toContain("spark_webhook_status_absent");
    expect(events(entries)).not.toContain("spark_webhook_non_success");
    expect(raw).not.toContain(PREIMAGE);
    const absentEntry = entries.find((entry) => entry.args?.event === "spark_webhook_status_absent")!;
    expect(absentEntry.level).toEqual("ERROR");
    expect(absentEntry.args?.payment_hash).toEqual(PAYMENT_HASH);
    expect(absentEntry.args?.payload_keys).toEqual(
      Object.keys(payload).filter((key) => payload[key] !== undefined).sort(),
    );
  }
});

Deno.test("the redacted payload of a status_absent failure is logged once per process", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const { entries } = await captureLogs(async () => {
    await deliver(h, { ...completed, status: undefined });
    await deliver(h, { ...completed, status: undefined });
  });
  const absent = entries.filter((entry) => entry.args?.event === "spark_webhook_status_absent");
  expect(absent.length).toEqual(2);
  const samples = absent.filter((entry) => entry.args?.payload !== undefined);
  expect(samples.length).toEqual(1);
  expect((samples[0].args?.payload as Record<string, unknown>).payment_preimage).toEqual("[redacted]");
});

Deno.test("a failed request status or transfer status is a 200 with no write and a non_success warning", async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...completed, request_status: "FAILED" },
    { ...completed, status: "TRANSFER_FAILED" },
    { ...completed, request_status: 1 },
  ];
  for (const payload of cases) {
    resetSparkWebhookLogState();
    const h = harness();
    const { result, entries } = await captureLogs(() => deliver(h, payload));
    expect(result.res.status).toEqual(200);
    expect(h.writes).toEqual([]);
    expect(h.lookups).toEqual([]);
    const entry = entries.find((e) => e.args?.event === "spark_webhook_non_success")!;
    expect(entry.level).toEqual("WARN");
    expect(entry.args?.request_status).toEqual(payload.request_status);
  }
});

Deno.test("a preimage that matches no invoice is a retryable 503 logged with the hash only", async () => {
  resetSparkWebhookLogState();
  const h = harness([]);
  const { result, entries, raw } = await captureLogs(() => deliver(h, completed));
  expect(result.res.status).toEqual(503);
  expect(result.json).toEqual({ status: "ERROR", reason: "unknown invoice" });
  const entry = entries.find((e) => e.args?.event === "spark_webhook_unknown_invoice")!;
  expect(entry.level).toEqual("ERROR");
  expect(entry.args?.payment_hash).toEqual(PAYMENT_HASH);
  expect(raw).not.toContain(PREIMAGE);
});

Deno.test("an NWC-minted invoice and a receiver mismatch are 200 with no write and a mismatch warning", async () => {
  resetSparkWebhookLogState();
  const nwcMinted = harness([[PAYMENT_HASH, { mintedBy: "nwc", receiverPubkey: null, preimage: null }]]);
  const first = await captureLogs(() => deliver(nwcMinted, completed));
  expect(first.result.res.status).toEqual(200);
  expect(nwcMinted.writes).toEqual([]);
  expect(events(first.entries)).toContain("spark_webhook_receiver_mismatch");

  const mismatch = harness();
  const second = await captureLogs(() =>
    deliver(mismatch, { ...completed, receiver_identity_public_key: "02" + "11".repeat(32) })
  );
  expect(second.result.res.status).toEqual(200);
  expect(mismatch.writes).toEqual([]);
  expect(events(second.entries)).toContain("spark_webhook_receiver_mismatch");
});

Deno.test("the receiver key compares case-insensitively and settles", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const { res } = await deliver(h, { ...completed, receiver_identity_public_key: KEY.toUpperCase() });
  expect(res.status).toEqual(200);
  expect(h.writes.length).toEqual(1);
});

Deno.test("an absent or null receiver key settles and logs the redacted payload once per process", async () => {
  resetSparkWebhookLogState();
  const first = harness([
    [PAYMENT_HASH, { mintedBy: "spark", receiverPubkey: KEY, preimage: null }],
    [hashOf(OTHER_PREIMAGE), { mintedBy: "spark", receiverPubkey: KEY, preimage: null }],
  ]);
  const { entries, raw } = await captureLogs(async () => {
    const { receiver_identity_public_key: _removed, ...withoutKey } = completed;
    await deliver(first, withoutKey);
    await deliver(first, { ...completed, payment_preimage: OTHER_PREIMAGE, receiver_identity_public_key: null });
  });
  expect(first.writes.length).toEqual(2);
  const logged = entries.filter((entry) => entry.args?.event === "spark_webhook_receiver_key_absent");
  expect(logged.length).toEqual(1);
  expect(logged[0].level).toEqual("WARN");
  expect((logged[0].args?.payload as Record<string, unknown>).payment_preimage).toEqual("[redacted]");
  expect(raw).not.toContain(PREIMAGE);
  expect(raw).not.toContain(OTHER_PREIMAGE);
});

Deno.test("a second delivery is 200, byte-identical, and does not overwrite", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const first = await deliver(h, completed, { now: T1 });
  const second = await deliver(h, completed, { now: T2 });
  expect(first.res.status).toEqual(200);
  expect(second.res.status).toEqual(200);
  expect(second.json).toEqual(first.json);
  expect(h.writes).toEqual([{ paymentHash: PAYMENT_HASH, preimage: PREIMAGE, settledAt: T1 }]);
});

Deno.test("a database error on lookup or write is a 500 with nothing leaked", async () => {
  resetSparkWebhookLogState();
  const lookupFails = harness(undefined, { lookup: true });
  const looked = await captureLogs(() => deliver(lookupFails, completed));
  expect(looked.result.res.status).toEqual(500);
  expect(looked.result.json).toEqual({ status: "ERROR", reason: "internal error" });
  expect(lookupFails.writes).toEqual([]);
  expect(looked.raw).not.toContain("connection refused");

  const writeFails = harness(undefined, { write: true });
  const wrote = await deliver(writeFails, completed);
  expect(wrote.res.status).toEqual(500);
  expect(wrote.json).toEqual({ status: "ERROR", reason: "internal error" });
});

Deno.test("no log entry holds a preimage, the HMAC secret, or a signature header value", async () => {
  resetSparkWebhookLogState();
  const h = harness();
  const goodBody = JSON.stringify(completed);
  const { raw } = await captureLogs(async () => {
    await deliver(h, completed);
    await deliver(h, completed);
    await deliver(h, completed, { signature: "00".repeat(32) });
    await deliver(h, { ...completed, request_status: "FAILED" });
    await deliver(h, { ...completed, status: undefined });
    await deliver(h, { ...completed, payment_preimage: OTHER_PREIMAGE });
  });
  expect(raw.length).toBeGreaterThan(0);
  for (const secret of [PREIMAGE, OTHER_PREIMAGE, SECRET, sign(goodBody), "00".repeat(32)]) {
    expect(raw).not.toContain(secret);
  }
});
