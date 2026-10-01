import { Hono } from "hono";
import { DB } from "../db/db.ts";
import { logger } from "../logger.ts";
import { verifySparkSignature } from "./hmac.ts";
import { decideSparkSettlement, redactPayload } from "./settlement.ts";
import type { SettlementLog } from "./settlement.ts";

const INTERNAL_ERROR = { status: "ERROR", reason: "internal error" } as const;

// Once per process: the first raw payload of each odd shape, redacted, is
// enough evidence to confirm the field names against the live SSP. The absent
// receiver key entry is logged once as a whole (it is expected on every
// delivery until the live shape is confirmed); the status_absent error entry
// is logged every time and carries the payload only the first time.
const sampled = { status_absent: false, receiver_key_absent: false };

/** Resets the once-per-process sampling. Tests only. */
export function resetSparkWebhookLogState(): void {
  sampled.status_absent = false;
  sampled.receiver_key_absent = false;
}

function emit(entry: SettlementLog, payload: unknown): void {
  const fields: Record<string, unknown> = { event: entry.event, ...entry.fields };
  if (entry.sample) {
    const first = !sampled[entry.sample];
    if (!first && entry.sample === "receiver_key_absent") return;
    if (first) {
      sampled[entry.sample] = true;
      fields.payload = redactPayload(payload);
    }
  }
  logger[entry.level](entry.event, fields);
}

/**
 * `POST /spark/webhook`. A preimage alone is not proof: the transfer must be
 * completed, the invoice Spark-minted, and the receiver key must match. See
 * `settlement.ts` for the decision table. `now` is Lite's clock; the payload
 * timestamp is ignored.
 */
export function createSparkWebhookApp(
  db: DB,
  webhookSecret: string,
  now: () => Date = () => new Date(),
) {
  const hono = new Hono();

  hono.post("/", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("X-Spark-Signature");
    if (!verifySparkSignature(webhookSecret, body, signature)) {
      logger.warn("spark webhook rejected", { event: "spark_webhook_invalid_signature" });
      return c.json({ status: "ERROR", reason: "invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      logger.warn("spark webhook rejected", { event: "spark_webhook_invalid_json" });
      return c.json({ status: "ERROR", reason: "invalid json" }, 400);
    }

    try {
      const decision = await decideSparkSettlement(payload, (paymentHash) =>
        db.findInvoiceByPaymentHash(paymentHash));
      if (decision.log) emit(decision.log, payload);
      if (decision.action === "respond") return c.json(decision.body, decision.status);

      const outcome = await db.settleSparkInvoice(decision.paymentHash, decision.preimage, now());
      if (outcome === "settled") {
        logger.info("spark invoice settled", {
          event: "spark_webhook_settled",
          payment_hash: decision.paymentHash,
        });
      } else {
        logger.debug("spark invoice already settled", {
          event: "spark_webhook_already_settled",
          payment_hash: decision.paymentHash,
        });
      }
      return c.json({ status: "OK" });
    } catch (error) {
      logger.error("spark webhook failed", {
        event: "spark_webhook_error",
        errorName: error instanceof Error ? error.name : "Error",
      });
      return c.json(INTERNAL_ERROR, 500);
    }
  });

  return hono;
}
