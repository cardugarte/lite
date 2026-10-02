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

export type Lud21VerifyOk = {
  status: "OK";
  settled: boolean;
  preimage: string | null;
  pr: string;
};

export type Lud21VerifyErr = {
  status: "ERROR";
  reason: string;
};

export type Lud21VerifyResponse = Lud21VerifyOk | Lud21VerifyErr;

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
 * - minted by Spark: webhook-only, so no lookup of any kind;
 * - minted by NWC while the owner is still on NWC: ask the wallet
 *   (`lookupInvoice`) and cache a preimage through the write-once path;
 * - minted by NWC after the owner moved to Spark: cached data only.
 *
 * A lookup failure stays unpaid so pollers do not 500.
 */
export async function verifyInvoiceSettlement(input: {
  invoice: StoredInvoice | null;
  ownerUserId: number | null;
  /** The owner's current destination (`nwc` or `spark`). */
  ownerDestination: string | null;
  lookupInvoice: () => Promise<NwcLookupResult | null>;
  markSettled: (lookup: NwcLookupResult) => Promise<void>;
  /** Called when an unsettled Spark invoice is verified, so a lost webhook can be reported. */
  onMissingSettlement?: (invoice: StoredInvoice) => void;
}): Promise<Lud21VerifyResponse> {
  const { invoice } = input;
  if (!invoice || input.ownerUserId === null || invoice.userId !== input.ownerUserId) {
    return { status: "ERROR", reason: "Not found" };
  }

  if (invoice.settledAt && invoice.preimage) {
    return {
      status: "OK",
      settled: true,
      preimage: invoice.preimage,
      pr: invoice.paymentRequest,
    };
  }

  const unpaid: Lud21VerifyOk = {
    status: "OK",
    settled: false,
    preimage: null,
    pr: invoice.paymentRequest,
  };

  if (invoice.mintedBy === "spark") {
    input.onMissingSettlement?.(invoice);
    return unpaid;
  }
  if (invoice.mintedBy !== "nwc" || input.ownerDestination !== "nwc") return unpaid;

  let lookup: NwcLookupResult | null = null;
  try {
    lookup = await input.lookupInvoice();
  } catch {
    lookup = null;
  }

  const preimage = settledPreimage(lookup);
  if (preimage) {
    try {
      await input.markSettled({ ...lookup, preimage });
    } catch {
      // Hub already paid; still return the proof even if the cache write fails.
    }
    return {
      status: "OK",
      settled: true,
      preimage,
      pr: invoice.paymentRequest,
    };
  }

  return unpaid;
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
