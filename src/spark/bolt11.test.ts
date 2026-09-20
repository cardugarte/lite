import { expect } from "jsr:@std/expect";
import { paymentHashFromBolt11 } from "./bolt11.ts";

// BOLT #11 example: payment_hash 0001020304050607080900010203040506070809000102030405060708090102
const SPEC_INVOICE =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";

Deno.test("paymentHashFromBolt11 reads the p tagged field", () => {
  expect(paymentHashFromBolt11(SPEC_INVOICE)).toEqual(
    "0001020304050607080900010203040506070809000102030405060708090102",
  );
});
