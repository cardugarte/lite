import { Hono } from "hono";
import { DB } from "../db/db.ts";
import { logger } from "../logger.ts";
import { paymentHashFromPreimage, verifySparkSignature } from "./hmac.ts";

type SparkWebhookPayload = {
  type?: string;
  payment_preimage?: string;
  timestamp?: string;
};

export function createSparkWebhookApp(db: DB, webhookSecret: string) {
  const hono = new Hono();

  hono.post("/", async (c) => {
    const body = await c.req.text();
    const signature = c.req.header("X-Spark-Signature");
    if (!verifySparkSignature(webhookSecret, body, signature)) {
      return c.json({ status: "ERROR", reason: "invalid signature" }, 401);
    }

    let payload: SparkWebhookPayload;
    try {
      payload = JSON.parse(body) as SparkWebhookPayload;
    } catch {
      return c.json({ status: "ERROR", reason: "invalid json" }, 400);
    }

    if (payload.type === "SPARK_LIGHTNING_RECEIVE_FINISHED") {
      const preimage = payload.payment_preimage?.trim().replace(/^0x/i, "");
      if (!preimage) {
        return c.json({ status: "ERROR", reason: "missing payment_preimage" }, 400);
      }
      const paymentHash = paymentHashFromPreimage(preimage);
      const settledAt = payload.timestamp
        ? new Date(payload.timestamp)
        : new Date();
      try {
        await db.markInvoiceSettledByPaymentHash(paymentHash, preimage, settledAt);
      } catch (error) {
        logger.error("error persisting spark receive preimage", {
          payment_hash: paymentHash,
          error,
        });
        return c.json({ status: "ERROR", reason: "" + error }, 500);
      }
    }

    return c.json({ status: "OK" });
  });

  return hono;
}
