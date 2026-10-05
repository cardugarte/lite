import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { SparkMinter } from "./minter.ts";

type SparkMinterIsInvoiceOnly = Exclude<keyof SparkMinter, "connect"> extends "createInvoice" ? true
  : false;
const sparkMinterIsInvoiceOnly: SparkMinterIsInvoiceOnly = true;

function assertNoSendApi(src: string) {
  expect(/\bsendPayment\b/.test(src)).toEqual(false);
  expect(/\bprepareSendPayment\b/.test(src)).toEqual(false);
}

Deno.test("breezMinter.ts never contains sendPayment or prepareSendPayment", () => {
  const src = Deno.readTextFileSync(new URL("./breezMinter.ts", import.meta.url));
  assertNoSendApi(src);
});

Deno.test("SparkMinter only exposes createInvoice", () => {
  const src = Deno.readTextFileSync(new URL("./minter.ts", import.meta.url));
  const match = src.match(/export type SparkMinter = \{([\s\S]*?)\n\};/);
  expect(match === null).toEqual(false);
  const methods = [...match![1].matchAll(/(\w+)\s*\(/g)].map((m) => m[1]);
  expect(methods.filter((name) => name !== "connect")).toEqual(["createInvoice"]);
  assertNoSendApi(src);
  expect(sparkMinterIsInvoiceOnly).toEqual(true);
});

Deno.test("breezMinter test SDK fake never needs a send method", () => {
  const src = Deno.readTextFileSync(
    new URL("./breezMinter.test.ts", import.meta.url),
  );
  assertNoSendApi(src);
});

// The SSP client authenticates as the minter and reads its receive requests.
// That is a lookup, not an SDK payment lookup, and it must never move money:
// the only GraphQL mutations it may hold are the two authentication steps.
Deno.test("the SSP client sends no mutation but the two authentication steps", () => {
  const src = Deno.readTextFileSync(new URL("./ssp.ts", import.meta.url));
  const mutations = [...src.matchAll(/\bmutation\s+(\w+)/g)].map((match) => match[1]).sort();
  expect(mutations).toEqual(["GetChallenge", "VerifyChallenge"]);
  assertNoSendApi(src);
});
