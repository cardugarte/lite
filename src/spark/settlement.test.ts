import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { decideSparkSettlement } from "./settlement.ts";

const PREIMAGE = "ab".repeat(32);
// Independent of the module under test: sha256 of the preimage bytes.
const PAYMENT_HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));
const KEY = "02aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const OTHER_KEY = "02bb" + "cc".repeat(31);

const completed = {
  type: "SPARK_LIGHTNING_RECEIVE_FINISHED",
  payment_preimage: PREIMAGE,
  request_status: "SUCCEEDED",
  status: "TRANSFER_COMPLETED",
  receiver_identity_public_key: KEY,
};

const sparkInvoice = { mintedBy: "spark", receiverPubkey: KEY };

function finder(invoice: { mintedBy: string; receiverPubkey: string | null } | null) {
  const asked: string[] = [];
  return {
    asked,
    find: async (hash: string) => {
      asked.push(hash);
      return invoice;
    },
  };
}

async function decide(payload: unknown, invoice: Parameters<typeof finder>[0] = sparkInvoice) {
  const lookup = finder(invoice);
  const decision = await decideSparkSettlement(payload, lookup.find);
  return { decision, asked: lookup.asked };
}

Deno.test("a completed transfer to the minted receiver settles with the normalized preimage", async () => {
  const { decision, asked } = await decide(completed);
  expect(decision).toEqual({
    action: "settle",
    paymentHash: PAYMENT_HASH,
    preimage: PREIMAGE,
    log: null,
  });
  expect(asked).toEqual([PAYMENT_HASH]);
});

Deno.test("a non-matching event type is acknowledged without a lookup", async () => {
  for (const payload of [{ ...completed, type: "SPARK_OTHER_EVENT" }, {}, [], null, "text", 7]) {
    const { decision, asked } = await decide(payload);
    expect(decision.action).toEqual("respond");
    if (decision.action !== "respond") throw new Error("unreachable");
    expect(decision.status).toEqual(200);
    expect(decision.body).toEqual({ status: "OK" });
    expect(decision.log?.level).toEqual("debug");
    expect(asked).toEqual([]);
  }
});

Deno.test("a missing or invalid preimage is a 400 before the status is looked at", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...completed, payment_preimage: undefined }, "missing payment_preimage"],
    [{ ...completed, payment_preimage: "" }, "missing payment_preimage"],
    [{ ...completed, payment_preimage: "   " }, "missing payment_preimage"],
    [{ ...completed, payment_preimage: 42 }, "missing payment_preimage"],
    [{ ...completed, payment_preimage: "zz".repeat(32) }, "invalid payment_preimage"],
    [{ ...completed, payment_preimage: "ab".repeat(31) }, "invalid payment_preimage"],
    [{ ...completed, payment_preimage: "0x" + "ab".repeat(31) }, "invalid payment_preimage"],
    // Precedence: a FAILED status with no preimage is still row 4.
    [{ type: completed.type, request_status: "FAILED" }, "missing payment_preimage"],
  ];
  for (const [payload, reason] of cases) {
    const { decision, asked } = await decide(payload);
    expect(decision).toMatchObject({
      action: "respond",
      status: 400,
      body: { status: "ERROR", reason },
      log: { level: "warn" },
    });
    expect(asked).toEqual([]);
  }
});

Deno.test("0x prefix, uppercase, and whitespace are normalized before the checks", async () => {
  for (const raw of ["0x" + PREIMAGE.toUpperCase(), "0X" + PREIMAGE, ` ${PREIMAGE.toUpperCase()}\n`]) {
    const { decision } = await decide({ ...completed, payment_preimage: raw });
    expect(decision).toMatchObject({ action: "settle", paymentHash: PAYMENT_HASH, preimage: PREIMAGE });
  }
});

Deno.test("an absent or null status field is a retryable 503 and never a non-success", async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...completed, request_status: undefined },
    { ...completed, status: undefined },
    { ...completed, request_status: null },
    { ...completed, status: null },
    { ...completed, request_status: undefined, status: undefined },
  ];
  for (const payload of cases) {
    const { decision, asked } = await decide(payload);
    expect(decision).toMatchObject({
      action: "respond",
      status: 503,
      body: { status: "ERROR", reason: "status fields missing" },
      log: { level: "error", event: "spark_webhook_status_absent", sample: "status_absent" },
    });
    if (decision.action !== "respond") throw new Error("unreachable");
    expect(decision.log?.fields.payment_hash).toEqual(PAYMENT_HASH);
    expect(decision.log?.fields.payload_keys).toEqual(Object.keys(payload).filter((k) => payload[k] !== undefined).sort());
    expect(JSON.stringify(decision.log)).not.toContain(PREIMAGE);
    expect(asked).toEqual([]);
  }
});

Deno.test("a present terminal non-success is a 200 with a non_success warning", async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...completed, request_status: "FAILED" },
    { ...completed, status: "TRANSFER_FAILED" },
    { ...completed, request_status: "FAILED", status: "TRANSFER_FAILED" },
    { ...completed, request_status: 1 },
    { ...completed, status: { nested: "TRANSFER_COMPLETED" } },
    { ...completed, request_status: "succeeded" },
  ];
  for (const payload of cases) {
    const { decision, asked } = await decide(payload);
    expect(decision).toMatchObject({
      action: "respond",
      status: 200,
      body: { status: "OK" },
      log: { level: "warn", event: "spark_webhook_non_success" },
    });
    if (decision.action !== "respond") throw new Error("unreachable");
    expect(decision.log?.fields.request_status).toEqual(payload.request_status);
    expect(decision.log?.fields.status).toEqual(payload.status);
    expect(asked).toEqual([]);
  }
});

Deno.test("an unknown invoice is a retryable 503 carrying only the payment hash", async () => {
  const { decision, asked } = await decide(completed, null);
  expect(decision).toMatchObject({
    action: "respond",
    status: 503,
    body: { status: "ERROR", reason: "unknown invoice" },
    log: { level: "error", event: "spark_webhook_unknown_invoice", fields: { payment_hash: PAYMENT_HASH } },
  });
  expect(JSON.stringify(decision)).not.toContain(PREIMAGE);
  expect(asked).toEqual([PAYMENT_HASH]);
});

Deno.test("an NWC-minted invoice and a receiver mismatch are acknowledged without a write", async () => {
  const nwcMinted = await decide(completed, { mintedBy: "nwc", receiverPubkey: null });
  expect(nwcMinted.decision).toMatchObject({
    action: "respond",
    status: 200,
    body: { status: "OK" },
    log: { level: "warn", event: "spark_webhook_receiver_mismatch" },
  });
  const mismatch = await decide({ ...completed, receiver_identity_public_key: OTHER_KEY });
  expect(mismatch.decision).toMatchObject({
    action: "respond",
    status: 200,
    log: { level: "warn", event: "spark_webhook_receiver_mismatch" },
  });
  // A present key of another type is present, and it differs.
  const numeric = await decide({ ...completed, receiver_identity_public_key: 5 });
  expect(numeric.decision).toMatchObject({ action: "respond", status: 200 });
});

Deno.test("the receiver key compares case-insensitively", async () => {
  const upper = await decide({ ...completed, receiver_identity_public_key: KEY.toUpperCase() });
  expect(upper.decision).toMatchObject({ action: "settle", paymentHash: PAYMENT_HASH, log: null });
  const stored = await decide(completed, { mintedBy: "spark", receiverPubkey: KEY.toUpperCase() });
  expect(stored.decision).toMatchObject({ action: "settle" });
});

Deno.test("an absent or null receiver key settles and flags the once-per-process log", async () => {
  for (const key of [undefined, null]) {
    const { decision } = await decide({ ...completed, receiver_identity_public_key: key });
    expect(decision).toMatchObject({
      action: "settle",
      paymentHash: PAYMENT_HASH,
      preimage: PREIMAGE,
      log: { level: "warn", event: "spark_webhook_receiver_key_absent", sample: "receiver_key_absent" },
    });
    expect(JSON.stringify(decision)).not.toContain(PREIMAGE + PREIMAGE);
  }
});

Deno.test("a lookup failure propagates so the webhook can answer 500", async () => {
  let failed = false;
  try {
    await decideSparkSettlement(completed, async () => {
      throw new Error("connection refused");
    });
  } catch (error) {
    failed = error instanceof Error && error.message === "connection refused";
  }
  expect(failed).toEqual(true);
});
