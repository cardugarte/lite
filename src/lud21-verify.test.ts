import { expect } from "jsr:@std/expect";
import { verifyInvoiceSettlement } from "./lud21-verify.ts";

const invoice = {
  userId: 7,
  settledAt: null as Date | null,
  preimage: null as string | null,
  paymentRequest: "lnbc30n1ptest",
  paymentHash: "aa".repeat(32),
};

Deno.test("returns Not found when the invoice is missing", async () => {
  const body = await verifyInvoiceSettlement({
    invoice: null,
    ownerUserId: 7,
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
  });
});

Deno.test("asks Hub via lookupInvoice and settles when a preimage is present", async () => {
  const preimage = "cc".repeat(32);
  const persisted: unknown[] = [];

  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
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
  });
  expect(persisted).toHaveLength(1);
});

Deno.test("returns unpaid when Hub says the invoice is still pending", async () => {
  let persisted = 0;

  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
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
  });
  expect(persisted).toBe(0);
});

Deno.test("returns unpaid when lookupInvoice fails — never 500 a poller", async () => {
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
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
  });
});

Deno.test("does not report settled:true without a preimage even if Hub state is settled", async () => {
  const body = await verifyInvoiceSettlement({
    invoice,
    ownerUserId: 7,
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
  });
});
