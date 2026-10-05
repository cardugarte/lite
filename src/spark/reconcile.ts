import type { DB } from "../db/db.ts";
import { logger } from "../logger.ts";
import { expiryFromBolt11 } from "./bolt11.ts";
import {
  COMPLETED_TRANSFER_STATUS,
  decideSparkSettlement,
  SPARK_RECEIVE_FINISHED,
  SUCCEEDED_REQUEST_STATUS,
} from "./settlement.ts";
import type { SettlementLog } from "./settlement.ts";
import { type SspClient, SspError, type SspLightningReceive } from "./ssp.ts";

/**
 * What the SSP list says about one Spark invoice.
 *
 * - `paid`: the record proves the payment and the invoice is settled (write-once);
 * - `unpaid`: the SSP answered and holds no proof of payment for it;
 * - `unknown`: Lite could not learn it (the SSP, the signer or the database failed,
 *   or the scan ran out of pages). Never to be read as "not paid".
 */
export type SparkReconcileOutcome =
  | { kind: "paid"; preimage: string }
  | { kind: "unpaid" }
  | { kind: "unknown" };

export type SparkReconciler = (invoice: {
  paymentHash: string;
  paymentRequest: string;
  createdAt: Date;
}) => Promise<SparkReconcileOutcome>;

/** One lookup per hash at a time, and no new one within this long of the last. */
export const RECONCILE_THROTTLE_MS = 5_000;
/** The scan goes back until it reaches entries older than the invoice's creation minus this. */
export const RECONCILE_LOOKBACK_MS = 3_600_000;
const DEFAULT_PAGE_SIZE = 100;
/** A hard stop on one scan: 1,000 records at the default page size. */
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_TRACKED_LIMIT = 1_000;
/** Failures are logged this often at most, with a count of those held back. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Settles a Spark invoice from the SSP list when someone asks for its status,
 * so a lost webhook no longer leaves a paid invoice unpaid (ADR 0014). No cron,
 * no queue: it runs only when verify asks.
 *
 * The SSP record is turned into the payload the webhook receives and decided by
 * the webhook's own rule (`decideSparkSettlement`): the transfer completed, the
 * invoice is Spark-minted, the receiver key matches. It also has to be the
 * invoice that was asked about: sha256 of the record's preimage is its hash.
 * The write is the webhook's write-once `settleSparkInvoice`, stamped with
 * Lite's clock. The SDK is never involved, and nothing here can send.
 */
export function createSparkReconciler(deps: {
  ssp: SspClient;
  db: Pick<DB, "findInvoiceByPaymentHash" | "settleSparkInvoice">;
  now?: () => Date;
  throttleMs?: number;
  lookbackMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** How many hashes the throttle remembers. */
  trackedLimit?: number;
}): SparkReconciler {
  const now = deps.now ?? (() => new Date());
  const throttleMs = deps.throttleMs ?? RECONCILE_THROTTLE_MS;
  const lookbackMs = deps.lookbackMs ?? RECONCILE_LOOKBACK_MS;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const trackedLimit = deps.trackedLimit ?? DEFAULT_TRACKED_LIMIT;

  const inflight = new Map<string, Promise<SparkReconcileOutcome>>();
  // Oldest first: a Map iterates in insertion order and every entry is re-inserted when it is updated.
  const recent = new Map<string, { at: number; outcome: SparkReconcileOutcome }>();
  let lastFailureLogAt = Number.NEGATIVE_INFINITY;
  let heldBackFailures = 0;

  function remember(hash: string, outcome: SparkReconcileOutcome): void {
    const at = now().getTime();
    recent.delete(hash);
    recent.set(hash, { at, outcome });
    for (const [key, entry] of recent) {
      if (recent.size <= trackedLimit && at - entry.at < throttleMs) break;
      recent.delete(key);
    }
  }

  function logFailure(paymentHash: string, error: unknown): void {
    const at = now().getTime();
    if (at - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) {
      heldBackFailures += 1;
      return;
    }
    lastFailureLogAt = at;
    const fields: Record<string, unknown> = {
      event: "spark_reconcile_failed",
      payment_hash: paymentHash,
      errorName: error instanceof Error ? error.name : "Error",
    };
    if (error instanceof SspError) {
      fields.kind = error.kind;
      if (error.status !== undefined) fields.http_status = error.status;
    }
    if (heldBackFailures > 0) {
      fields.suppressed = heldBackFailures;
      heldBackFailures = 0;
    }
    logger.warn("spark reconcile failed", fields);
  }

  /** The decision's own log entry, marked as coming from the SSP list. It never carries a preimage. */
  function emit(entry: SettlementLog | null): void {
    if (entry) logger[entry.level](entry.event, { event: entry.event, ...entry.fields, source: "ssp_list" });
  }

  async function settleFrom(record: SspLightningReceive, hash: string): Promise<SparkReconcileOutcome> {
    // Still waiting, or ended without payment: not the webhook's business, and not worth a warning.
    if (record.request_status !== SUCCEEDED_REQUEST_STATUS || record.status !== COMPLETED_TRANSFER_STATUS) {
      return { kind: "unpaid" };
    }
    const decision = await decideSparkSettlement(
      {
        type: SPARK_RECEIVE_FINISHED,
        payment_preimage: record.payment_preimage,
        request_status: record.request_status,
        status: record.status,
        receiver_identity_public_key: record.receiver_identity_public_key,
      },
      (paymentHash) => deps.db.findInvoiceByPaymentHash(paymentHash),
    );
    if (decision.action === "respond") {
      emit(decision.log);
      // 503 is the webhook's "try again later": the invoice row was not there to read.
      return decision.status === 503 ? { kind: "unknown" } : { kind: "unpaid" };
    }
    // The decision hashes the record's preimage. That must be the invoice asked about,
    // or the proof belongs to another invoice and settles neither.
    if (decision.paymentHash !== hash) {
      logger.warn("spark reconcile hash mismatch", { event: "spark_reconcile_hash_mismatch", payment_hash: hash });
      return { kind: "unpaid" };
    }
    emit(decision.log);
    const write = await deps.db.settleSparkInvoice(hash, decision.preimage, now());
    logger.info("spark invoice reconciled", { event: "spark_settlement_reconciled", payment_hash: hash, write });
    return { kind: "paid", preimage: decision.preimage };
  }

  /**
   * When the invoice was created: the earlier of its BOLT11 timestamp and its
   * row's creation time, so a database clock or time zone that is off cannot
   * stop the scan before it reaches the record.
   */
  function createdAtMs(invoice: { paymentRequest: string; createdAt: Date }): number {
    const rowMs = invoice.createdAt.getTime();
    try {
      return Math.min(rowMs, expiryFromBolt11(invoice.paymentRequest).timestamp * 1000);
    } catch {
      return rowMs;
    }
  }

  const olderThan = (entries: SspLightningReceive[], floorMs: number): boolean =>
    entries.some((entry) => {
      const createdMs = Date.parse(entry.created_at ?? "");
      return !Number.isNaN(createdMs) && createdMs < floorMs;
    });

  async function scan(invoice: { paymentHash: string; paymentRequest: string; createdAt: Date }): Promise<SparkReconcileOutcome> {
    const hash = invoice.paymentHash.toLowerCase();
    const floorMs = createdAtMs(invoice) - lookbackMs;
    let after: string | undefined;
    for (let pages = 0; pages < maxPages; pages++) {
      const page = await deps.ssp.listLightningReceives({ first: pageSize, after });
      const record = page.entries.find((entry) => entry.invoice.payment_hash.toLowerCase() === hash);
      if (record) return await settleFrom(record, hash);
      if (!page.hasNextPage) return { kind: "unpaid" };
      // More pages exist but there is no way to reach them.
      if (page.endCursor === null) return { kind: "unknown" };
      // Newest first: past the invoice's lifetime, nothing further back can be it.
      if (olderThan(page.entries, floorMs)) return { kind: "unpaid" };
      after = page.endCursor;
    }
    return { kind: "unknown" };
  }

  return (invoice) => {
    const hash = invoice.paymentHash.toLowerCase();
    const running = inflight.get(hash);
    if (running) return running;
    const last = recent.get(hash);
    if (last && now().getTime() - last.at < throttleMs) return Promise.resolve(last.outcome);

    const lookup = (async (): Promise<SparkReconcileOutcome> => {
      let outcome: SparkReconcileOutcome;
      try {
        outcome = await scan(invoice);
      } catch (error) {
        logFailure(hash, error);
        outcome = { kind: "unknown" };
      }
      remember(hash, outcome);
      return outcome;
    })().finally(() => {
      inflight.delete(hash);
    });
    inflight.set(hash, lookup);
    return lookup;
  };
}
