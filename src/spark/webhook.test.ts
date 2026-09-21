import "./../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { hmac } from "npm:@noble/hashes@1.3.1/hmac";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import type { DB } from "../db/db.ts";
import { createSparkWebhookApp } from "./webhook.ts";

const SECRET = "spark-webhook-secret";
const PREIMAGE = "ab".repeat(32);
const PAYMENT_HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));

function sign(body: string): string {
  return bytesToHex(
    hmac(sha256, new TextEncoder().encode(SECRET), new TextEncoder().encode(body)),
  );
}

function mockDb(persist: Array<{ paymentHash: string; preimage: string }>) {
  return {
    markInvoiceSettledByPaymentHash: async (
      paymentHash: string,
      preimage: string,
    ) => {
      persist.push({ paymentHash, preimage });
    },
  } as unknown as DB;
}

Deno.test("POST /spark/webhook rejects a bad HMAC", async () => {
  const persist: Array<{ paymentHash: string; preimage: string }> = [];
  const app = createSparkWebhookApp(mockDb(persist), SECRET);
  const body = JSON.stringify({
    type: "SPARK_LIGHTNING_RECEIVE_FINISHED",
    payment_preimage: PREIMAGE,
  });
  const res = await app.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Spark-Signature": "00".repeat(32),
    },
    body,
  });
  expect(res.status).toEqual(401);
  expect(persist).toHaveLength(0);
});

Deno.test("POST /spark/webhook persists preimage on SPARK_LIGHTNING_RECEIVE_FINISHED", async () => {
  const persist: Array<{ paymentHash: string; preimage: string }> = [];
  const app = createSparkWebhookApp(mockDb(persist), SECRET);
  const body = JSON.stringify({
    type: "SPARK_LIGHTNING_RECEIVE_FINISHED",
    payment_preimage: PREIMAGE,
    receiver_identity_public_key: "02abc",
    timestamp: "2026-03-09T12:00:06Z",
  });
  const res = await app.request("/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Spark-Signature": sign(body),
    },
    body,
  });
  expect(res.status).toEqual(200);
  expect(persist).toEqual([{ paymentHash: PAYMENT_HASH, preimage: PREIMAGE }]);
});
