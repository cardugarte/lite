export type StoredInvoice = {
  userId: number;
  settledAt: Date | null;
  preimage: string | null;
  paymentRequest: string;
  paymentHash: string;
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
 * Cached `settled_at` + preimage is enough. Otherwise ask the wallet
 * (`lookupInvoice`). A missed `payment_received` must not keep a paid
 * invoice `settled: false`. Lookup failures stay unpaid so pollers do
 * not 500.
 */
export async function verifyInvoiceSettlement(input: {
  invoice: StoredInvoice | null;
  ownerUserId: number | null;
  lookupInvoice: () => Promise<NwcLookupResult | null>;
  markSettled: (lookup: NwcLookupResult) => Promise<void>;
}): Promise<Lud21VerifyResponse> {
  if (
    !input.invoice ||
    input.ownerUserId === null ||
    input.invoice.userId !== input.ownerUserId
  ) {
    return { status: "ERROR", reason: "Not found" };
  }

  if (input.invoice.settledAt && input.invoice.preimage) {
    return {
      status: "OK",
      settled: true,
      preimage: input.invoice.preimage,
      pr: input.invoice.paymentRequest,
    };
  }

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
      pr: input.invoice.paymentRequest,
    };
  }

  return {
    status: "OK",
    settled: false,
    preimage: input.invoice.preimage,
    pr: input.invoice.paymentRequest,
  };
}
