import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import { nwc } from "npm:@getalby/sdk";
import type { DB } from "./db/db.ts";
import { createLnurlApp } from "./lnurlp.ts";
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
  }> = [];
  const invoices: unknown[] = [];
  const minter: SparkMinter = {
    async createInvoice(input) {
      minted.push(input);
      return { invoice: "lnbc1sparkinvoice", paymentHash: PAYMENT_HASH };
    },
  };
  const db = {
    findUser: async () => sparkUser(),
    createInvoice: async (userId: number, transaction: { invoice: string }) => {
      invoices.push({ userId, invoice: transaction.invoice });
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
    { receiverIdentityPubkey: ROW_PUBKEY, amountSats: 2500, memo: "hi" },
  ]);
  expect(invoices).toEqual([{ userId: 7, invoice: "lnbc1sparkinvoice" }]);
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
    destination: null,
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
  const calls: Array<{ secret?: string; amount?: number; description?: string }> = [];
  const original = nwc.NWCClient.prototype.makeInvoice;
  nwc.NWCClient.prototype.makeInvoice = async function (
    this: { secret?: string },
    request: { amount?: number; description?: string },
  ) {
    calls.push({
      secret: this.secret,
      amount: request.amount,
      description: request.description,
    });
    return {
      invoice: "lnbc1nwcinvoice",
      payment_hash: PAYMENT_HASH,
      amount: request.amount ?? 0,
      description: request.description ?? "",
    } as nwc.Nip47Transaction;
  } as typeof nwc.NWCClient.prototype.makeInvoice;

  const invoices: Array<{ userId: number; invoice: string; paymentHash: string }> = [];
  const db = {
    findUser: async () => nwcUser(),
    createInvoice: async (
      userId: number,
      transaction: { invoice: string; payment_hash: string },
    ) => {
      invoices.push({
        userId,
        invoice: transaction.invoice,
        paymentHash: transaction.payment_hash,
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
    }]);
    expect(invoices).toEqual([{
      userId: 3,
      invoice: "lnbc1nwcinvoice",
      paymentHash: PAYMENT_HASH,
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
