import { paymentHashFromPreimage } from "./hmac.ts";

/** What the decision needs to know about the invoice a payment hash resolves to. */
export interface SettlementInvoice {
  mintedBy: string;
  receiverPubkey: string | null;
}

export type SettlementLogLevel = "debug" | "info" | "warn" | "error";

/** A structured log entry the webhook emits. Never carries a preimage. */
export interface SettlementLog {
  level: SettlementLogLevel;
  /** Stable `event` field of the log entry. */
  event: string;
  fields: Record<string, unknown>;
  /** The webhook adds a redacted payload sample, once per process, for these entries. */
  sample?: "status_absent" | "receiver_key_absent";
}

export type SparkSettlementDecision =
  | {
    action: "respond";
    status: 200 | 400 | 503;
    body: { status: "OK" } | { status: "ERROR"; reason: string };
    log: SettlementLog | null;
  }
  | { action: "settle"; paymentHash: string; preimage: string; log: SettlementLog | null };

export const SPARK_RECEIVE_FINISHED = "SPARK_LIGHTNING_RECEIVE_FINISHED";
export const SUCCEEDED_REQUEST_STATUS = "SUCCEEDED";
export const COMPLETED_TRANSFER_STATUS = "TRANSFER_COMPLETED";

const PREIMAGE_HEX = /^[0-9a-f]{64}$/;
const OK = { status: "OK" } as const;

const respond = (
  status: 200 | 400 | 503,
  body: { status: "OK" } | { status: "ERROR"; reason: string },
  log: SettlementLog | null,
): SparkSettlementDecision => ({ action: "respond", status, body, log });

const absent = (value: unknown): boolean => value === undefined || value === null;

/** Trimmed, `0x` prefix removed, lowercased. The stored preimage is this value. */
export function normalizePreimage(raw: string): string {
  return raw.trim().replace(/^0x/i, "").toLowerCase();
}

/** The payload with its preimage replaced, safe to log. */
export function redactPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if ("payment_preimage" in copy) copy.payment_preimage = "[redacted]";
  return copy;
}

/**
 * The webhook settlement table, rows 3 to 10, as a decision. A preimage alone
 * is not proof: the transfer must be completed, the invoice must be
 * Spark-minted, and the receiver key must match when present. `findInvoice` is
 * called only after the cheap checks pass, so a malformed payload never reads
 * the database; its failures propagate (row 11 is the caller's 500).
 */
export async function decideSparkSettlement(
  payload: unknown,
  findInvoice: (paymentHash: string) => Promise<SettlementInvoice | null>,
): Promise<SparkSettlementDecision> {
  const fields: Record<string, unknown> =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};

  // Row 3.
  if (fields.type !== SPARK_RECEIVE_FINISHED) {
    return respond(200, OK, { level: "debug", event: "spark_webhook_ignored_type", fields: {} });
  }

  // Row 4.
  const rawPreimage = fields.payment_preimage;
  const preimage = typeof rawPreimage === "string" ? normalizePreimage(rawPreimage) : "";
  if (preimage === "") {
    return respond(400, { status: "ERROR", reason: "missing payment_preimage" }, {
      level: "warn",
      event: "spark_webhook_missing_preimage",
      fields: {},
    });
  }
  if (!PREIMAGE_HEX.test(preimage)) {
    return respond(400, { status: "ERROR", reason: "invalid payment_preimage" }, {
      level: "warn",
      event: "spark_webhook_invalid_preimage",
      fields: {},
    });
  }
  const paymentHash = paymentHashFromPreimage(preimage);

  // Row 5a: the payload lacks the shape this design expects, so retry rather than drop a payment.
  if (absent(fields.request_status) || absent(fields.status)) {
    return respond(503, { status: "ERROR", reason: "status fields missing" }, {
      level: "error",
      event: "spark_webhook_status_absent",
      fields: {
        payment_hash: paymentHash,
        payload_keys: Object.keys(fields).filter((key) => fields[key] !== undefined).sort(),
      },
      sample: "status_absent",
    });
  }
  // Row 5b: a present terminal non-success is final.
  if (
    fields.request_status !== SUCCEEDED_REQUEST_STATUS ||
    fields.status !== COMPLETED_TRANSFER_STATUS
  ) {
    return respond(200, OK, {
      level: "warn",
      event: "spark_webhook_non_success",
      fields: {
        payment_hash: paymentHash,
        request_status: fields.request_status,
        status: fields.status,
      },
    });
  }

  // Row 6: the invoice row may commit after the webhook arrives, so retry.
  const invoice = await findInvoice(paymentHash);
  if (!invoice) {
    return respond(503, { status: "ERROR", reason: "unknown invoice" }, {
      level: "error",
      event: "spark_webhook_unknown_invoice",
      fields: { payment_hash: paymentHash },
    });
  }

  // Row 7.
  if (invoice.mintedBy !== "spark") {
    return respond(200, OK, {
      level: "warn",
      event: "spark_webhook_receiver_mismatch",
      fields: { payment_hash: paymentHash, reason: "invoice not minted by spark" },
    });
  }

  // Rows 8 and 9.
  const key = fields.receiver_identity_public_key;
  if (!absent(key)) {
    const matches = typeof key === "string" && invoice.receiverPubkey !== null &&
      key.toLowerCase() === invoice.receiverPubkey.toLowerCase();
    if (!matches) {
      return respond(200, OK, {
        level: "warn",
        event: "spark_webhook_receiver_mismatch",
        fields: { payment_hash: paymentHash, reason: "receiver key differs" },
      });
    }
    return { action: "settle", paymentHash, preimage, log: null };
  }
  return {
    action: "settle",
    paymentHash,
    preimage,
    log: {
      level: "warn",
      event: "spark_webhook_receiver_key_absent",
      fields: { payment_hash: paymentHash },
      sample: "receiver_key_absent",
    },
  };
}
