import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import { nwc } from "npm:@getalby/sdk";
import { INVOICE_EXPIRY_SECS } from "./constants.ts";
import type { DB } from "./db/db.ts";
import { createLnurlApp } from "./lnurlp.ts";
import { logger } from "./logger.ts";
import type { SparkMinter } from "./spark/minter.ts";

const ROW_PUBKEY =
  "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ATTACKER =
  "02cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PREIMAGE = "cd".repeat(32);
const PAYMENT_HASH = "ee".repeat(32);

function sparkUser() {
  return {
    id: 7,
    nostrPubkey: "aa".repeat(32),
    connectionSecret: null,
    destination: "spark",
    sparkIdentityPubkey: ROW_PUBKEY,
  };
}

Deno.test("LNURL callback mints with the row identity pubkey and ignores request destination", async () => {
  const minted: Array<{
    receiverIdentityPubkey: string;
    amountSats: number;
    memo: string;
    expirySecs: number;
  }> = [];
  const invoices: unknown[] = [];
  const minter: SparkMinter = {
    async createInvoice(input) {
      minted.push(input);
      return { invoice: "lnbc1sparkinvoice", paymentHash: PAYMENT_HASH, receiverPubkey: ROW_PUBKEY };
    },
  };
  const db = {
    findUser: async () => sparkUser(),
    createInvoice: async (
      userId: number,
      transaction: { invoice: string },
      minted?: { by: string; receiverPubkey?: string },
    ) => {
      invoices.push({ userId, invoice: transaction.invoice, minted });
    },
  } as unknown as DB;

  const app = createLnurlApp(db, minter);
  const res = await app.request(
    `/alice/callback?amount=2500000&destination=${ATTACKER}&comment=hi`,
  );
  expect(res.status).toEqual(200);
  expect(await res.json()).toEqual({
    verify: `http://lnaddr.test/lnurlp/alice/verify/${PAYMENT_HASH}`,
    routes: [],
    pr: "lnbc1sparkinvoice",
  });
  expect(minted).toEqual([
    { receiverIdentityPubkey: ROW_PUBKEY, amountSats: 2500, memo: "hi", expirySecs: INVOICE_EXPIRY_SECS },
  ]);
  expect(invoices).toEqual([{
    userId: 7,
    invoice: "lnbc1sparkinvoice",
    minted: { by: "spark", receiverPubkey: ROW_PUBKEY },
  }]);
});

Deno.test("LUD-21 spark verify returns settled from persisted preimage without lookupInvoice", async () => {
  let lookupCalls = 0;
  const db = {
    findUser: async () => sparkUser(),
    findInvoice: async () => ({
      userId: 7,
      settledAt: new Date("2026-03-09T12:00:06Z"),
      preimage: PREIMAGE,
      paymentRequest: "lnbc1sparkinvoice",
      paymentHash: PAYMENT_HASH,
      mintedBy: "spark",
      createdAt: new Date("2026-03-09T12:00:00Z"),
    }),
    markInvoiceSettled: async () => {
      throw new Error("NWC markInvoiceSettled must not run");
    },
  } as unknown as DB;

  const app = createLnurlApp(db, {
    createInvoice: async () => {
      throw new Error("mint must not run on verify");
    },
  });

  const originalLookup = globalThis.fetch;
  try {
    const res = await app.request(`/alice/verify/${PAYMENT_HASH}`);
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({
      status: "OK",
      settled: true,
      preimage: PREIMAGE,
      pr: "lnbc1sparkinvoice",
    });
    expect(lookupCalls).toBe(0);
  } finally {
    globalThis.fetch = originalLookup;
  }
});

Deno.test("LUD-21 spark unpaid verify does not construct NWC lookupInvoice", async () => {
  const db = {
    findUser: async () => sparkUser(),
    findInvoice: async () => ({
      userId: 7,
      settledAt: null,
      preimage: null,
      paymentRequest: "lnbc1sparkinvoice",
      paymentHash: PAYMENT_HASH,
      mintedBy: "spark",
      createdAt: new Date(),
    }),
    markInvoiceSettled: async () => {
      throw new Error("persist must not run");
    },
  } as unknown as DB;

  const app = createLnurlApp(db, {
    createInvoice: async () => {
      throw new Error("mint must not run on verify");
    },
  });
  const res = await app.request(`/alice/verify/${PAYMENT_HASH}`);
  expect(await res.json()).toEqual({
    status: "OK",
    settled: false,
    preimage: null,
    pr: "lnbc1sparkinvoice",
  });
});

const NWC_URL =
  "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";
const NWC_SECRET = "bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";

function nwcUser() {
  return {
    id: 3,
    nostrPubkey: "aa".repeat(32),
    connectionSecret: NWC_URL,
    destination: "nwc",
    sparkIdentityPubkey: null,
  };
}

function minterThatMustNotRun(): SparkMinter {
  return {
    async createInvoice() {
      throw new Error("spark mint must not run for an NWC user");
    },
  };
}

Deno.test("LNURL callback for an NWC user uses makeInvoice and returns that invoice", async () => {
  const calls: Array<{ secret?: string; amount?: number; description?: string; expiry?: number }> = [];
  const original = nwc.NWCClient.prototype.makeInvoice;
  nwc.NWCClient.prototype.makeInvoice = async function (
    this: { secret?: string },
    request: { amount?: number; description?: string; expiry?: number },
  ) {
    calls.push({
      secret: this.secret,
      amount: request.amount,
      description: request.description,
      expiry: request.expiry,
    });
    return {
      invoice: "lnbc1nwcinvoice",
      payment_hash: PAYMENT_HASH,
      amount: request.amount ?? 0,
      description: request.description ?? "",
    } as nwc.Nip47Transaction;
  } as typeof nwc.NWCClient.prototype.makeInvoice;

  const invoices: Array<{
    userId: number;
    invoice: string;
    paymentHash: string;
    minted?: { by: string; receiverPubkey?: string | null };
  }> = [];
  const db = {
    findUser: async () => nwcUser(),
    createInvoice: async (
      userId: number,
      transaction: { invoice: string; payment_hash: string },
      minted?: { by: string; receiverPubkey?: string | null },
    ) => {
      invoices.push({
        userId,
        invoice: transaction.invoice,
        paymentHash: transaction.payment_hash,
        minted,
      });
    },
  } as unknown as DB;

  try {
    const app = createLnurlApp(db, minterThatMustNotRun());
    const res = await app.request("/bob/callback?amount=2500000&comment=hi");
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({
      verify: `http://lnaddr.test/lnurlp/bob/verify/${PAYMENT_HASH}`,
      routes: [],
      pr: "lnbc1nwcinvoice",
    });
    expect(calls).toEqual([{
      secret: NWC_SECRET,
      amount: 2500000,
      description: "hi",
      expiry: INVOICE_EXPIRY_SECS,
    }]);
    expect(invoices).toEqual([{
      userId: 3,
      invoice: "lnbc1nwcinvoice",
      paymentHash: PAYMENT_HASH,
      minted: { by: "nwc" },
    }]);
  } finally {
    nwc.NWCClient.prototype.makeInvoice = original;
  }
});

Deno.test("unpaid NWC LUD-21 verify calls owner lookupInvoice and settles the preimage", async () => {
  const preimage = "cc".repeat(32);
  const lookups: Array<{ secret?: string; paymentHash?: string }> = [];
  const settled: Array<{ userId: number; preimage?: string; paymentHash?: string }> = [];
  const original = nwc.NWCClient.prototype.lookupInvoice;
  nwc.NWCClient.prototype.lookupInvoice = async function (
    this: { secret?: string },
    request: { payment_hash?: string },
  ) {
    lookups.push({ secret: this.secret, paymentHash: request.payment_hash });
    return {
      preimage,
      settled_at: 1_700_000_000,
      state: "settled",
      payment_hash: request.payment_hash,
      invoice: "lnbc1nwcinvoice",
    } as unknown as nwc.Nip47Transaction;
  } as typeof nwc.NWCClient.prototype.lookupInvoice;

  const db = {
    findUser: async () => nwcUser(),
    findInvoice: async () => ({
      userId: 3,
      settledAt: null,
      preimage: null,
      paymentRequest: "lnbc1nwcinvoice",
      paymentHash: PAYMENT_HASH,
      mintedBy: "nwc",
      createdAt: new Date(),
    }),
    markInvoiceSettled: async (
      userId: number,
      transaction: { preimage?: string; payment_hash?: string },
    ) => {
      settled.push({
        userId,
        preimage: transaction.preimage,
        paymentHash: transaction.payment_hash,
      });
    },
  } as unknown as DB;

  try {
    const app = createLnurlApp(db, minterThatMustNotRun());
    const res = await app.request(`/bob/verify/${PAYMENT_HASH}`);
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({
      status: "OK",
      settled: true,
      preimage,
      pr: "lnbc1nwcinvoice",
    });
    expect(lookups).toEqual([{ secret: NWC_SECRET, paymentHash: PAYMENT_HASH }]);
    expect(settled).toEqual([{
      userId: 3,
      preimage,
      paymentHash: PAYMENT_HASH,
    }]);
  } finally {
    nwc.NWCClient.prototype.lookupInvoice = original;
  }
});

// ---------------------------------------------------------------------------
// L9.3: verify follows the invoice, not the user's current credential.
// ---------------------------------------------------------------------------

const UNPAID_SPARK = { status: "OK", settled: false, preimage: null, pr: "lnbc1sparkinvoice" };

function storedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    userId: 3,
    settledAt: null,
    preimage: null,
    paymentRequest: "lnbc1sparkinvoice",
    paymentHash: PAYMENT_HASH,
    mintedBy: "spark",
    createdAt: new Date(),
    ...overrides,
  };
}

/** Replaces the NWC client methods with spies that record calls and, for lookup, answer a preimage. */
function spyOnNwcLookup() {
  const calls: string[] = [];
  const original = nwc.NWCClient.prototype.lookupInvoice;
  nwc.NWCClient.prototype.lookupInvoice = async function () {
    calls.push("lookupInvoice");
    return { preimage: PREIMAGE, settled_at: 1_700_000_000, state: "settled" } as unknown as nwc.Nip47Transaction;
  } as typeof nwc.NWCClient.prototype.lookupInvoice;
  return {
    calls,
    restore: () => {
      nwc.NWCClient.prototype.lookupInvoice = original;
    },
  };
}

function minterWithSdkSpies() {
  const calls: string[] = [];
  const minter = {
    createInvoice: async () => {
      throw new Error("mint must not run on verify");
    },
    getPayment: () => void calls.push("getPayment"),
    listPayments: () => void calls.push("listPayments"),
  } as unknown as SparkMinter;
  return { minter, calls };
}

Deno.test("a Spark invoice of a user now on NWC is never looked up on the NWC wallet or the SDK", async () => {
  const spy = spyOnNwcLookup();
  const { minter, calls } = minterWithSdkSpies();
  try {
    const db = {
      findUser: async () => nwcUser(),
      findInvoice: async () => storedInvoice(),
      markInvoiceSettled: async () => {
        throw new Error("persist must not run");
      },
    } as unknown as DB;
    const res = await createLnurlApp(db, minter).request(`/bob/verify/${PAYMENT_HASH}`);
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual(UNPAID_SPARK);
    expect(spy.calls).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    spy.restore();
  }
});

Deno.test("a Spark invoice settled by webhook verifies as settled after the owner switched to NWC", async () => {
  const spy = spyOnNwcLookup();
  try {
    const db = {
      findUser: async () => nwcUser(),
      findInvoice: async () =>
        storedInvoice({ settledAt: new Date("2026-03-09T12:00:06Z"), preimage: PREIMAGE }),
    } as unknown as DB;
    const res = await createLnurlApp(db, minterWithSdkSpies().minter).request(`/bob/verify/${PAYMENT_HASH}`);
    expect(await res.json()).toEqual({ status: "OK", settled: true, preimage: PREIMAGE, pr: "lnbc1sparkinvoice" });
    expect(spy.calls).toEqual([]);
  } finally {
    spy.restore();
  }
});

Deno.test("an NWC invoice of a user now on Spark makes no lookup and answers unpaid", async () => {
  const spy = spyOnNwcLookup();
  try {
    const db = {
      findUser: async () => ({ ...sparkUser(), id: 3 }),
      findInvoice: async () => storedInvoice({ mintedBy: "nwc", paymentRequest: "lnbc1nwcinvoice" }),
      markInvoiceSettled: async () => {
        throw new Error("persist must not run");
      },
    } as unknown as DB;
    const res = await createLnurlApp(db, minterWithSdkSpies().minter).request(`/alice/verify/${PAYMENT_HASH}`);
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ status: "OK", settled: false, preimage: null, pr: "lnbc1nwcinvoice" });
    expect(spy.calls).toEqual([]);
  } finally {
    spy.restore();
  }
});

Deno.test("a thrown NWC lookup answers HTTP 200 unpaid, and another user's invoice is Not found", async () => {
  const original = nwc.NWCClient.prototype.lookupInvoice;
  nwc.NWCClient.prototype.lookupInvoice = async function () {
    throw new Error("relay timeout");
  } as typeof nwc.NWCClient.prototype.lookupInvoice;
  try {
    const db = {
      findUser: async () => nwcUser(),
      findInvoice: async () => storedInvoice({ mintedBy: "nwc", paymentRequest: "lnbc1nwcinvoice" }),
    } as unknown as DB;
    const res = await createLnurlApp(db).request(`/bob/verify/${PAYMENT_HASH}`);
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ status: "OK", settled: false, preimage: null, pr: "lnbc1nwcinvoice" });

    const other = {
      findUser: async () => nwcUser(),
      findInvoice: async () => storedInvoice({ userId: 99, mintedBy: "nwc" }),
    } as unknown as DB;
    const notFound = await createLnurlApp(other).request(`/bob/verify/${PAYMENT_HASH}`);
    expect(notFound.status).toEqual(200);
    expect(await notFound.json()).toEqual({ status: "ERROR", reason: "Not found" });
  } finally {
    nwc.NWCClient.prototype.lookupInvoice = original;
  }
});

Deno.test("verify logs spark_settlement_missing once per hash for an old unsettled Spark invoice", async () => {
  const now = new Date("2026-03-09T12:10:00Z");
  const writable = logger as unknown as { levelName: string; handlers: Array<{ levelName: string }> };
  const previousLevel = writable.levelName;
  const previousHandlers = writable.handlers.map((handler) => handler.levelName);
  writable.levelName = "DEBUG";
  for (const handler of writable.handlers) handler.levelName = "DEBUG";
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  try {
    const ageOf = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    for (const [seconds, calls] of [[360, 3], [240, 1], [300, 1]] as const) {
      const db = {
        findUser: async () => ({ ...sparkUser(), id: 3 }),
        findInvoice: async () => storedInvoice({ createdAt: ageOf(seconds), paymentHash: `${seconds}` }),
      } as unknown as DB;
      const app = createLnurlApp(db, minterWithSdkSpies().minter, () => now);
      for (let i = 0; i < calls; i++) {
        const res = await app.request(`/alice/verify/${seconds}`);
        expect(await res.json()).toEqual(UNPAID_SPARK);
      }
    }
  } finally {
    console.log = original;
    writable.levelName = previousLevel;
    writable.handlers.forEach((handler, index) => {
      handler.levelName = previousHandlers[index];
    });
  }
  const missing = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.args?.event === "spark_settlement_missing");
  expect(missing.length).toEqual(1);
  expect(missing[0].level).toEqual("WARN");
  expect(missing[0].args.payment_hash).toEqual("360");
  expect(missing[0].args.age_seconds).toEqual(360);
  expect(lines.join("\n")).not.toContain(PREIMAGE);
});

Deno.test("the mint records the receiver key the minter reports, not a value read from elsewhere", async () => {
  const reported = "02dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const minter: SparkMinter = {
    async createInvoice() {
      return { invoice: "lnbc1sparkinvoice", paymentHash: PAYMENT_HASH, receiverPubkey: reported };
    },
  };
  const written: Array<{ by: string; receiverPubkey?: string }> = [];
  const db = {
    findUser: async () => sparkUser(),
    createInvoice: async (_userId: number, _tx: unknown, minted: { by: string; receiverPubkey?: string }) => {
      written.push(minted);
    },
  } as unknown as DB;
  const res = await createLnurlApp(db, minter).request("/alice/callback?amount=1000000");
  expect(res.status).toEqual(200);
  expect(written).toEqual([{ by: "spark", receiverPubkey: reported }]);
});

// ---------------------------------------------------------------------------
// Every invoice carries the configured expiry, so it ends when the payment
// countdown does. One setting feeds both mint paths.
// ---------------------------------------------------------------------------

Deno.test("a configured invoice expiry reaches the Spark minter as expirySecs", async () => {
  const seen: number[] = [];
  const minter: SparkMinter = {
    async createInvoice(input) {
      seen.push(input.expirySecs);
      return { invoice: "lnbc1sparkinvoice", paymentHash: PAYMENT_HASH, receiverPubkey: ROW_PUBKEY };
    },
  };
  const db = {
    findUser: async () => sparkUser(),
    createInvoice: async () => {},
  } as unknown as DB;
  const app = createLnurlApp(db, minter, undefined, { invoiceExpirySecs: 120 });
  expect((await app.request("/alice/callback?amount=1000000")).status).toEqual(200);
  expect(seen).toEqual([120]);
});

Deno.test("a configured invoice expiry reaches the NWC wallet as expiry", async () => {
  const seen: Array<number | undefined> = [];
  const original = nwc.NWCClient.prototype.makeInvoice;
  nwc.NWCClient.prototype.makeInvoice = async function (request: { amount?: number; expiry?: number }) {
    seen.push(request.expiry);
    return {
      invoice: "lnbc1nwcinvoice",
      payment_hash: PAYMENT_HASH,
      amount: request.amount ?? 0,
    } as nwc.Nip47Transaction;
  } as typeof nwc.NWCClient.prototype.makeInvoice;
  try {
    const db = { findUser: async () => nwcUser(), createInvoice: async () => {} } as unknown as DB;
    const app = createLnurlApp(db, undefined, undefined, { invoiceExpirySecs: 120 });
    expect((await app.request("/bob/callback?amount=1000000")).status).toEqual(200);
    expect(seen).toEqual([120]);
  } finally {
    nwc.NWCClient.prototype.makeInvoice = original;
  }
});
