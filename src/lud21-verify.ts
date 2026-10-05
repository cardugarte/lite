import { preimageMatchesPaymentHash } from "./preimage.ts";
import { expiryFromBolt11 } from "./spark/bolt11.ts";
import type { SparkReconcileOutcome } from "./spark/reconcile.ts";

export type StoredInvoice = {
  userId: number;
  settledAt: Date | null;
  preimage: string | null;
  paymentRequest: string;
  paymentHash: string;
  /** Who minted the invoice (`nwc` or `spark`). Settlement follows this, never the user's current credential. */
  mintedBy: string;
  createdAt: Date;
};

export type NwcLookupResult = {
  preimage?: string | null;
  settled_at?: number;
  state?: string;
  payment_hash?: string;
};

/** What Lite answers for an invoice it minted. */
export type InvoiceStatus = "paid" | "pending" | "expired";

export type Lud21VerifyOk = {
  status: "OK";
  settled: boolean;
  preimage: string | null;
  pr: string;
  /**
   * Additive, outside LUD-21 (whose `status` is the LNURL envelope and stays
   * "OK"). `paid` exactly when `settled` is true. `expired` once the invoice's
   * own expiry has passed with no proof of payment. `pending` for everything
   * else, including every case where Lite could not learn the state.
   */
  payment_status: InvoiceStatus;
};

export type Lud21VerifyErr = {
  status: "ERROR";
  reason: string;
};

export type Lud21VerifyResponse = Lud21VerifyOk | Lud21VerifyErr;

/** True once the invoice's own expiry has passed. An invoice that cannot be decoded has no known expiry, so it is never expired. */
function isExpired(paymentRequest: string, nowMs: number): boolean {
  try {
    return nowMs >= expiryFromBolt11(paymentRequest).expiresAt * 1000;
  } catch {
    return false;
  }
}

function settledPreimage(lookup: NwcLookupResult | null): string | null {
  if (typeof lookup?.preimage !== "string" || lookup.preimage.length === 0) {
    return null;
  }
  return lookup.preimage;
}

/**
 * LUD-21 body for GET /lnurlp/:user/verify/:payment_hash.
 *
 * How to check follows the invoice, not a credential left on the user row:
 *
 * - settled (cached preimage and `settled_at`): answer from the cache;
 * - minted by Spark: the webhook settles it; when it has not, ask the SSP list
 *   through `reconcileSpark`, which settles a proven payment write-once. Never
 *   the NWC wallet, whatever the owner's destination is now, and never the SDK;
 * - minted by NWC while the owner is still on NWC: ask the wallet
 *   (`lookupInvoice`) and cache a preimage through the write-once path, but
 *   only a preimage whose sha256 is the invoice's payment hash counts;
 * - minted by NWC after the owner moved to Spark: cached data only.
 *
 * The answer is `paid`, `pending` or `expired`. A lookup that fails or
 * contradicts itself is `pending`, never "not paid", so pollers do not 500 and
 * a booking is not failed on a guess. With no lookup, or a lookup that found
 * no payment, the invoice's own expiry (its BOLT11 timestamp plus expiry)
 * decides between `pending` and `expired`.
 */
export async function verifyInvoiceSettlement(input: {
  invoice: StoredInvoice | null;
  ownerUserId: number | null;
  /** The owner's current destination (`nwc` or `spark`). */
  ownerDestination: string | null;
  lookupInvoice: () => Promise<NwcLookupResult | null>;
  markSettled: (lookup: NwcLookupResult) => Promise<void>;
  /**
   * Looks an unsettled Spark invoice up in the SSP list and settles it when it
   * was paid. Absent where there is no minter.
   */
  reconcileSpark?: (invoice: StoredInvoice) => Promise<SparkReconcileOutcome>;
  /**
   * Called when a Spark invoice is unsettled and Lite could not rule out a lost
   * webhook: it had no way to ask the SSP, or the SSP could not answer.
   */
  onMissingSettlement?: (invoice: StoredInvoice) => void;
  /** Called when the wallet answers with a preimage that does not hash to the invoice's payment hash. */
  onPreimageMismatch?: (invoice: StoredInvoice) => void;
  /** Lite's clock, for the invoice's expiry. */
  now?: () => Date;
}): Promise<Lud21VerifyResponse> {
  const { invoice } = input;
  if (!invoice || input.ownerUserId === null || invoice.userId !== input.ownerUserId) {
    return { status: "ERROR", reason: "Not found" };
  }

  const paid = (preimage: string): Lud21VerifyOk => ({
    status: "OK",
    settled: true,
    preimage,
    pr: invoice.paymentRequest,
    payment_status: "paid",
  });
  const unpaid = (status: Exclude<InvoiceStatus, "paid">): Lud21VerifyOk => ({
    status: "OK",
    settled: false,
    preimage: null,
    pr: invoice.paymentRequest,
    payment_status: status,
  });
  /** Nothing proves a payment and nothing failed: the invoice's own clock decides. */
  const byExpiry = (): Lud21VerifyOk =>
    unpaid(isExpired(invoice.paymentRequest, (input.now ?? (() => new Date()))().getTime()) ? "expired" : "pending");

  if (invoice.settledAt && invoice.preimage) return paid(invoice.preimage);

  if (invoice.mintedBy === "spark") {
    let outcome: SparkReconcileOutcome | null = null;
    if (input.reconcileSpark) {
      try {
        outcome = await input.reconcileSpark(invoice);
      } catch {
        outcome = { kind: "unknown" };
      }
    }
    if (outcome?.kind === "paid") return paid(outcome.preimage);
    // An SSP that answered "unpaid" rules out a lost webhook; anything else does not.
    if (outcome?.kind !== "unpaid") input.onMissingSettlement?.(invoice);
    return outcome?.kind === "unknown" ? unpaid("pending") : byExpiry();
  }
  if (invoice.mintedBy !== "nwc" || input.ownerDestination !== "nwc") return byExpiry();

  let lookup: NwcLookupResult | null;
  try {
    lookup = await input.lookupInvoice();
  } catch {
    return unpaid("pending");
  }

  const preimage = settledPreimage(lookup);
  if (!preimage) return byExpiry();
  if (!preimageMatchesPaymentHash(preimage, invoice.paymentHash)) {
    input.onPreimageMismatch?.(invoice);
    return unpaid("pending");
  }
  try {
    await input.markSettled({ ...lookup, preimage });
  } catch {
    // Hub already paid; still return the proof even if the cache write fails.
  }
  return paid(preimage);
}

/** A Spark invoice still unsettled after this long probably lost its webhook. */
export const MISSING_SETTLEMENT_AGE_SECS = 300;
export const MISSING_SETTLEMENT_TRACKED_LIMIT = 1000;

/**
 * Reports an unsettled Spark invoice older than five minutes, once per payment
 * hash per process. The tracked set is bounded: when full, the oldest hash is
 * forgotten (it may be reported again). Young invoices are not tracked.
 */
export function createMissingSettlementReporter(options: {
  now: () => Date;
  log: (fields: { payment_hash: string; age_seconds: number }) => void;
  limit?: number;
}) {
  const limit = options.limit ?? MISSING_SETTLEMENT_TRACKED_LIMIT;
  const tracked = new Set<string>();
  const report = (invoice: Pick<StoredInvoice, "paymentHash" | "createdAt">): void => {
    const ageMs = options.now().getTime() - invoice.createdAt.getTime();
    if (ageMs <= MISSING_SETTLEMENT_AGE_SECS * 1000) return;
    if (tracked.has(invoice.paymentHash)) return;
    if (tracked.size >= limit) {
      const oldest = tracked.values().next().value;
      if (oldest !== undefined) tracked.delete(oldest);
    }
    tracked.add(invoice.paymentHash);
    options.log({ payment_hash: invoice.paymentHash, age_seconds: Math.floor(ageMs / 1000) });
  };
  report.tracked = (): number => tracked.size;
  return report;
}
