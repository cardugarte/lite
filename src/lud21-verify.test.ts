import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import {
  createMissingSettlementReporter,
  type Lud21VerifyOk,
  verifyInvoiceSettlement,
} from "./lud21-verify.ts";
import { makeInvoice } from "./test_bolt11.ts";

/** The payment hash a preimage proves, computed here and not by the code under test. */
const hashOf = (preimage: string) => bytesToHex(sha256(hexToBytes(preimage)));
const PREIMAGE = "cc".repeat(32);

const invoice = {
  userId: 7,
  settledAt: null as Date | null,
  preimage: null as string | null,
  paymentRequest: "lnbc30n1ptest",
  paymentHash: hashOf(PREIMAGE),
  mintedBy: "nwc",
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

Deno.test("returns Not found when the invoice is missing", async () => {
  const body = await verifyInvoiceSettlement({
    invoice: null,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: () => {
      throw new Error("lookup must not run");
    },
    markSettled: () => {
      throw new Error("persist must not run");
    },
  });

  expect(body).toEqual({ status: "ERROR", reason: "Not found" });
});

Deno.test("returns Not found when the username does not own the invoice", async () => {
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 99,
    ownerDestination: "nwc",
    lookupInvoice: () => {
      throw new Error("lookup must not run");
    },
    markSettled: () => {
      throw new Error("persist must not run");
    },
  });

  expect(body).toEqual({ status: "ERROR", reason: "Not found" });
});

Deno.test("returns cached settlement without asking the wallet", async () => {
  const body = await verifyInvoiceSettlement({
    invoice: {
      ...invoice,
      settledAt: new Date("2026-09-01T00:00:00Z"),
      preimage: "bb".repeat(32),
    },
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: () => {
      throw new Error("lookup must not run");
    },
    markSettled: () => {
      throw new Error("persist must not run");
    },
  });

  expect(body).toEqual({
    status: "OK",
    settled: true,
    preimage: "bb".repeat(32),
    pr: invoice.paymentRequest,
    payment_status: "paid",
  });
});

Deno.test("asks Hub via lookupInvoice and settles when a preimage is present", async () => {
  const preimage = PREIMAGE;
  const persisted: unknown[] = [];

  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: async () => ({
      preimage,
      settled_at: 1_700_000_000,
      state: "settled",
      payment_hash: invoice.paymentHash,
    }),
    markSettled: async (lookup: { preimage?: string | null }) => {
      persisted.push(lookup);
    },
  });

  expect(body).toEqual({
    status: "OK",
    settled: true,
    preimage,
    pr: invoice.paymentRequest,
    payment_status: "paid",
  });
  expect(persisted).toHaveLength(1);
});

Deno.test("returns unpaid when Hub says the invoice is still pending", async () => {
  let persisted = 0;

  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: async () => ({
      preimage: null,
      state: "pending",
      payment_hash: invoice.paymentHash,
    }),
    markSettled: async () => {
      persisted += 1;
    },
  });

  expect(body).toEqual({
    status: "OK",
    settled: false,
    preimage: null,
    pr: invoice.paymentRequest,
    payment_status: "pending",
  });
  expect(persisted).toBe(0);
});

Deno.test("returns unpaid when lookupInvoice fails — never 500 a poller", async () => {
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: async () => {
      throw new Error("relay timeout");
    },
    markSettled: async () => {
      throw new Error("persist must not run");
    },
  });

  expect(body).toEqual({
    status: "OK",
    settled: false,
    preimage: null,
    pr: invoice.paymentRequest,
    payment_status: "pending",
  });
});

Deno.test("does not report settled:true without a preimage even if Hub state is settled", async () => {
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: async () => ({
      preimage: "",
      state: "settled",
      payment_hash: invoice.paymentHash,
    }),
    markSettled: async () => {
      throw new Error("persist must not run");
    },
  });

  expect(body).toEqual({
    status: "OK",
    settled: false,
    preimage: null,
    pr: invoice.paymentRequest,
    payment_status: "pending",
  });
});

const unpaidResult = {
  status: "OK",
  settled: false,
  preimage: null,
  pr: invoice.paymentRequest,
  payment_status: "pending",
};

Deno.test("a Spark invoice is never looked up on the NWC wallet, whatever the owner's destination now is", async () => {
  for (const ownerDestination of ["nwc", "spark"] as const) {
    const body = await verifyInvoiceSettlement({
      invoice: { ...invoice, mintedBy: "spark" },
      ownerUserId: 7,
      ownerDestination,
      lookupInvoice: () => {
        throw new Error("lookup must not run");
      },
      markSettled: () => {
        throw new Error("persist must not run");
      },
    });
    expect({ ownerDestination, body }).toEqual({ ownerDestination, body: unpaidResult });
  }
});

Deno.test("a Spark invoice settled by webhook verifies as settled after the owner moved to NWC", async () => {
  const body = await verifyInvoiceSettlement({
    invoice: {
      ...invoice,
      mintedBy: "spark",
      settledAt: new Date("2026-09-01T00:05:00Z"),
      preimage: "dd".repeat(32),
    },
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: () => {
      throw new Error("lookup must not run");
    },
    markSettled: () => {
      throw new Error("persist must not run");
    },
  });
  expect(body).toEqual({
    status: "OK",
    settled: true,
    preimage: "dd".repeat(32),
    pr: invoice.paymentRequest,
    payment_status: "paid",
  });
});

Deno.test("an NWC invoice is not looked up once the owner has moved to Spark", async () => {
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "spark",
    lookupInvoice: () => {
      throw new Error("lookup must not run");
    },
    markSettled: () => {
      throw new Error("persist must not run");
    },
  });
  expect(body).toEqual(unpaidResult);
});

Deno.test("an NWC invoice owned by an NWC row is looked up and cached", async () => {
  let lookups = 0;
  const persisted: unknown[] = [];
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: async () => {
      lookups += 1;
      return { preimage: PREIMAGE, settled_at: 1_700_000_000, payment_hash: invoice.paymentHash };
    },
    markSettled: async (lookup) => {
      persisted.push(lookup.preimage);
    },
  });
  expect(body).toEqual({
    status: "OK",
    settled: true,
    preimage: PREIMAGE,
    pr: invoice.paymentRequest,
    payment_status: "paid",
  });
  expect(lookups).toEqual(1);
  expect(persisted).toEqual([PREIMAGE]);
});

Deno.test("an NWC preimage that does not hash to the payment hash settles nothing", async () => {
  const wrong = "dd".repeat(32);
  expect(hashOf(wrong)).not.toEqual(invoice.paymentHash);
  let persisted = 0;
  const mismatches: string[] = [];
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: async () => ({
      preimage: wrong,
      settled_at: 1_700_000_000,
      state: "settled",
      payment_hash: invoice.paymentHash,
    }),
    markSettled: async () => {
      persisted += 1;
    },
    onPreimageMismatch: (stored) => void mismatches.push(stored.paymentHash),
  });
  expect(body).toEqual(unpaidResult);
  expect(persisted).toBe(0);
  expect(mismatches).toEqual([invoice.paymentHash]);
});

Deno.test("an NWC preimage that is not 32 bytes of hex settles nothing", async () => {
  for (const preimage of ["not-a-preimage", "cc".repeat(31), "zz".repeat(32)]) {
    let persisted = 0;
    const body = await verifyInvoiceSettlement({
      invoice,
      ownerUserId: 7,
      ownerDestination: "nwc",
      lookupInvoice: async () => ({ preimage, state: "settled", payment_hash: invoice.paymentHash }),
      markSettled: async () => {
        persisted += 1;
      },
    });
    expect({ preimage, body, persisted }).toEqual({ preimage, body: unpaidResult, persisted: 0 });
  }
});

Deno.test("an NWC preimage is checked against the stored hash, not the hash the wallet echoes", async () => {
  const wrong = "dd".repeat(32);
  let persisted = 0;
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    // The wallet's own answer is self-consistent, but it is for another invoice.
    lookupInvoice: async () => ({ preimage: wrong, state: "settled", payment_hash: hashOf(wrong) }),
    markSettled: async () => {
      persisted += 1;
    },
  });
  expect(body).toEqual(unpaidResult);
  expect(persisted).toBe(0);
});

// ---------------------------------------------------------------------------
// The answer is paid, pending or expired. `settled` keeps its meaning and the
// LUD-21 `status: "OK"` stays; `payment_status` is the additive field.
// ---------------------------------------------------------------------------

const MINTED_AT_S = 1_790_000_000;
const EXPIRY_SECS = 300;
/** An invoice minted at MINTED_AT_S that expires 300 seconds later. */
const liveInvoice = {
  ...invoice,
  paymentRequest: makeInvoice({ paymentHash: invoice.paymentHash, timestamp: MINTED_AT_S, expirySecs: EXPIRY_SECS }),
};
/** Lite's clock `seconds` after the mint. */
const secondsAfterMint = (seconds: number) => () => new Date((MINTED_AT_S + seconds) * 1000);

const walletSaysPending = async () => ({ state: "pending", preimage: null, payment_hash: invoice.paymentHash });
const neverPersist = async () => {
  throw new Error("persist must not run");
};

function verifyAt(
  seconds: number,
  overrides: Partial<Parameters<typeof verifyInvoiceSettlement>[0]> = {},
) {
  return verifyInvoiceSettlement({
    invoice: liveInvoice,
    ownerUserId: 7,
    ownerDestination: "nwc",
    lookupInvoice: walletSaysPending,
    markSettled: neverPersist,
    now: secondsAfterMint(seconds),
    ...overrides,
  });
}

/** The answer, which must be the LUD-21 OK envelope. */
async function verifyOk(
  seconds: number,
  overrides: Partial<Parameters<typeof verifyInvoiceSettlement>[0]> = {},
): Promise<Lud21VerifyOk> {
  const body = await verifyAt(seconds, overrides);
  if (body.status !== "OK") throw new Error(`expected an OK answer, got ${body.reason}`);
  return body;
}

const statusOf = async (body: Promise<Lud21VerifyOk>) => (await body).payment_status;

Deno.test("an unsettled invoice is pending until its expiry and expired from then on", async () => {
  expect(await statusOf(verifyOk(0))).toEqual("pending");
  expect(await statusOf(verifyOk(EXPIRY_SECS - 1))).toEqual("pending");
  expect(await statusOf(verifyOk(EXPIRY_SECS))).toEqual("expired");
  expect(await statusOf(verifyOk(10_000))).toEqual("expired");
});

Deno.test("an expired answer is still the LUD-21 envelope: status OK, settled false, no preimage", async () => {
  expect(await verifyOk(10_000)).toEqual({
    status: "OK",
    settled: false,
    preimage: null,
    pr: liveInvoice.paymentRequest,
    payment_status: "expired",
  });
});

Deno.test("a wallet that cannot be asked is pending, never expired, even past the expiry", async () => {
  const failing = verifyOk(10_000, {
    lookupInvoice: async () => {
      throw new Error("relay timeout");
    },
  });
  expect(await failing).toEqual({
    status: "OK",
    settled: false,
    preimage: null,
    pr: liveInvoice.paymentRequest,
    payment_status: "pending",
  });
});

Deno.test("a wallet answer that contradicts itself is pending, never expired", async () => {
  const wrong = "dd".repeat(32);
  const body = await verifyOk(10_000, {
    lookupInvoice: async () => ({ preimage: wrong, state: "settled", payment_hash: invoice.paymentHash }),
  });
  expect(body.settled).toBe(false);
  expect(await statusOf(Promise.resolve(body))).toEqual("pending");
});

Deno.test("an invoice nobody can look up is expired once its expiry passes", async () => {
  // An NWC invoice whose owner moved to Spark: the wallet secret is gone, so there is nothing to ask.
  const noLookup = { ownerDestination: "spark", lookupInvoice: () => Promise.reject(new Error("never asked")) };
  expect(await statusOf(verifyOk(EXPIRY_SECS - 1, noLookup))).toEqual("pending");
  expect(await statusOf(verifyOk(EXPIRY_SECS, noLookup))).toEqual("expired");
});

Deno.test("a stored payment request that cannot be decoded is pending whatever the time", async () => {
  for (const seconds of [0, 10_000, 100_000_000]) {
    const body = await verifyOk(seconds, { invoice });
    expect({ seconds, status: body.payment_status }).toEqual({ seconds, status: "pending" });
  }
});

Deno.test("paid beats expiry: a cached settlement and a late wallet proof both answer paid", async () => {
  const cached = await verifyOk(10_000, {
    invoice: { ...liveInvoice, settledAt: new Date(), preimage: PREIMAGE },
    lookupInvoice: () => Promise.reject(new Error("lookup must not run")),
  });
  expect(cached).toEqual({
    status: "OK",
    settled: true,
    preimage: PREIMAGE,
    pr: liveInvoice.paymentRequest,
    payment_status: "paid",
  });
  const persisted: unknown[] = [];
  const late = await verifyOk(10_000, {
    lookupInvoice: async () => ({ preimage: PREIMAGE, settled_at: MINTED_AT_S + 1_000, state: "settled" }),
    markSettled: async (lookup) => void persisted.push(lookup.preimage),
  });
  expect(late.payment_status).toEqual("paid");
  expect(late.settled).toBe(true);
  expect(persisted).toEqual([PREIMAGE]);
});

Deno.test("settled is true exactly when the answer is paid", async () => {
  const answers = [
    await verifyOk(0),
    await verifyOk(10_000),
    await verifyOk(0, { lookupInvoice: async () => ({ preimage: PREIMAGE, state: "settled" }), markSettled: async () => {} }),
    await verifyOk(0, { invoice: { ...liveInvoice, settledAt: new Date(), preimage: PREIMAGE } }),
  ];
  expect(answers.map((body) => [body.settled, body.payment_status])).toEqual([
    [false, "pending"],
    [false, "expired"],
    [true, "paid"],
    [true, "paid"],
  ]);
});

Deno.test("an unsettled Spark invoice is pending until its expiry and expired after it", async () => {
  const spark = { invoice: { ...liveInvoice, mintedBy: "spark" }, ownerDestination: "spark" };
  expect(await statusOf(verifyOk(EXPIRY_SECS - 1, spark))).toEqual("pending");
  expect(await statusOf(verifyOk(EXPIRY_SECS, spark))).toEqual("expired");
});

Deno.test("an error answer carries no payment_status", async () => {
  const body = await verifyAt(0, { invoice: null });
  expect(body).toEqual({ status: "ERROR", reason: "Not found" });
});

Deno.test("the missing-settlement hook fires only for unsettled Spark invoices", async () => {
  const seen: string[] = [];
  const base = {
    ownerUserId: 7,
    ownerDestination: "nwc" as const,
    lookupInvoice: async () => null,
    markSettled: async () => {},
    onMissingSettlement: (stored: { paymentHash: string }) => void seen.push(stored.paymentHash),
  };
  await verifyInvoiceSettlement({ ...base, invoice: { ...invoice, mintedBy: "spark" } });
  await verifyInvoiceSettlement({ ...base, invoice });
  await verifyInvoiceSettlement({
    ...base,
    invoice: { ...invoice, mintedBy: "spark", settledAt: new Date(), preimage: "ff".repeat(32) },
  });
  expect(seen).toEqual([invoice.paymentHash]);
});

Deno.test("the missing-settlement reporter logs once per hash after more than 300 seconds", () => {
  const now = new Date("2026-09-01T01:00:00Z");
  const logged: Array<Record<string, unknown>> = [];
  const report = createMissingSettlementReporter({
    now: () => now,
    log: (fields) => void logged.push(fields),
  });
  const ageSeconds = (seconds: number, hash: string) => ({
    ...invoice,
    paymentHash: hash,
    createdAt: new Date(now.getTime() - seconds * 1000),
  });

  report(ageSeconds(240, "young"));
  report(ageSeconds(300, "boundary"));
  expect(logged).toEqual([]);

  report(ageSeconds(301, "old"));
  report(ageSeconds(360, "six-minutes"));
  report(ageSeconds(360, "six-minutes"));
  report(ageSeconds(361, "six-minutes"));
  expect(logged).toEqual([
    { payment_hash: "old", age_seconds: 301 },
    { payment_hash: "six-minutes", age_seconds: 360 },
  ]);
});

Deno.test("the missing-settlement reporter tracks at most 1,000 hashes", () => {
  const now = new Date("2026-09-01T01:00:00Z");
  let count = 0;
  const report = createMissingSettlementReporter({ now: () => now, log: () => void (count += 1) });
  for (let i = 0; i < 1001; i++) {
    report({ ...invoice, paymentHash: `hash-${i}`, createdAt: new Date(now.getTime() - 600_000) });
  }
  expect(count).toEqual(1001);
  expect(report.tracked()).toEqual(1000);
});
