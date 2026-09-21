import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
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
