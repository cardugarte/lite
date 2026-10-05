import { expect } from "jsr:@std/expect";
import { makeInvoice } from "../test_bolt11.ts";
import { expiryFromBolt11, paymentHashFromBolt11 } from "./bolt11.ts";

// BOLT #11 example: payment_hash 0001020304050607080900010203040506070809000102030405060708090102
const SPEC_INVOICE =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
// BOLT #11 example "send $3 for a cup of coffee ... within one minute": it carries an x field of 60.
const COFFEE_INVOICE =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp";
const SPEC_TIMESTAMP = 1496314658;
const HASH = "0001020304050607080900010203040506070809000102030405060708090102";

Deno.test("paymentHashFromBolt11 reads the p tagged field", () => {
  expect(paymentHashFromBolt11(SPEC_INVOICE)).toEqual(HASH);
});

Deno.test("expiryFromBolt11 applies the BOLT11 default of 3600 seconds when there is no x field", () => {
  expect(expiryFromBolt11(SPEC_INVOICE)).toEqual({
    timestamp: SPEC_TIMESTAMP,
    expirySecs: 3600,
    expiresAt: SPEC_TIMESTAMP + 3600,
  });
});

Deno.test("expiryFromBolt11 reads the x field of a spec invoice", () => {
  expect(paymentHashFromBolt11(COFFEE_INVOICE)).toEqual(HASH);
  expect(expiryFromBolt11(COFFEE_INVOICE)).toEqual({
    timestamp: SPEC_TIMESTAMP,
    expirySecs: 60,
    expiresAt: SPEC_TIMESTAMP + 60,
  });
});

Deno.test("expiryFromBolt11 reads x fields of one group, several groups and the largest the SDK accepts", () => {
  const timestamp = 1_790_000_000;
  for (const expirySecs of [1, 31, 32, 300, 3600, 2_592_000, 4_294_967_295]) {
    const invoice = makeInvoice({ paymentHash: HASH, timestamp, expirySecs });
    expect({ expirySecs, parsed: expiryFromBolt11(invoice) }).toEqual({
      expirySecs,
      parsed: { timestamp, expirySecs, expiresAt: timestamp + expirySecs },
    });
  }
});

Deno.test("expiryFromBolt11 reads timestamps beyond 32 bits", () => {
  const timestamp = 34_359_738_367; // 2^35 - 1, the largest a 7-group timestamp holds
  const invoice = makeInvoice({ paymentHash: HASH, timestamp, expirySecs: 300 });
  expect(expiryFromBolt11(invoice).timestamp).toEqual(timestamp);
});

Deno.test("the signature is never read as tagged fields", () => {
  // Groups 6, 0, 1, 5 look like an x field of 5 seconds; they sit in the signature.
  const signature = [6, 0, 1, 5, ...new Array<number>(100).fill(0)];
  const invoice = makeInvoice({ paymentHash: HASH, timestamp: 1_790_000_000, signature });
  expect(expiryFromBolt11(invoice).expirySecs).toEqual(3600);
  expect(paymentHashFromBolt11(invoice)).toEqual(HASH);
});

Deno.test("expiryFromBolt11 rejects a string that is not an invoice", () => {
  const tooShort = "lnbc1" + "q".repeat(60); // fewer groups than a timestamp and a signature
  for (const invoice of ["", "not an invoice", "lnbc1", "lnbc1sparkinvoice", "lnbc1" + "q".repeat(12), tooShort]) {
    expect(() => expiryFromBolt11(invoice)).toThrow();
  }
});
