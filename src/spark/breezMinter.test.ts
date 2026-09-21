import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { createBreezSparkMinter, sparkReceiveWebhookUrl } from "./breezMinter.ts";

const SPEC_INVOICE =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";

const WEBHOOK_URL = "http://lnaddr.test/spark/webhook";
const WEBHOOK_SECRET = "spark-webhook-secret";

Deno.test("main.ts subscribes the minter webhook to the shipped handler", () => {
  const src = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
  expect(src.includes("sparkReceiveWebhookUrl(BASE_URL)")).toEqual(true);
  expect(src.includes("webhookSecret: SPARK_WEBHOOK_SECRET")).toEqual(true);
  expect(src.includes('hono.route("/spark/webhook"')).toEqual(true);
});

Deno.test("sparkReceiveWebhookUrl is BASE_URL plus /spark/webhook", () => {
  expect(sparkReceiveWebhookUrl("http://lnaddr.test")).toEqual(
    "http://lnaddr.test/spark/webhook",
  );
  expect(sparkReceiveWebhookUrl("http://lnaddr.test/")).toEqual(
    "http://lnaddr.test/spark/webhook",
  );
});

Deno.test("connects then registers SPARK_LIGHTNING_RECEIVE webhook before minting", async () => {
  const order: string[] = [];
  const webhookCalls: Array<{
    url: string;
    secret: string;
    eventTypes: Array<{ type: string }>;
  }> = [];

  const minter = createBreezSparkMinter({
    apiKey: "test-api-key",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    webhookUrl: WEBHOOK_URL,
    webhookSecret: WEBHOOK_SECRET,
    loadBreez: async () => ({
      defaultConfig: (network: string) => ({ apiKey: undefined, network }),
      connect: async () => {
        order.push("connect");
        return {
          registerWebhook: async (request: {
            url: string;
            secret: string;
            eventTypes: Array<{ type: string }>;
          }) => {
            order.push("registerWebhook");
            webhookCalls.push(request);
            return { webhookId: "wh-1" };
          },
          receivePayment: async () => {
            order.push("receivePayment");
            return { paymentRequest: SPEC_INVOICE };
          },
        };
      },
    }),
  });

  const minted = await minter.createInvoice({
    receiverIdentityPubkey: "02" + "ab".repeat(32),
    amountSats: 21,
    memo: "booking",
  });

  expect(order).toEqual(["connect", "registerWebhook", "receivePayment"]);
  expect(webhookCalls).toEqual([{
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    eventTypes: [{ type: "lightningReceiveFinished" }],
  }]);
  expect(minted.invoice).toEqual(SPEC_INVOICE);
  expect(minted.paymentHash).toEqual(
    "0001020304050607080900010203040506070809000102030405060708090102",
  );
});

Deno.test("does not mint if webhook registration fails", async () => {
  let receiveCalls = 0;
  const minter = createBreezSparkMinter({
    apiKey: "test-api-key",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    webhookUrl: WEBHOOK_URL,
    webhookSecret: WEBHOOK_SECRET,
    loadBreez: async () => ({
      defaultConfig: () => ({ apiKey: undefined }),
      connect: async () => ({
        registerWebhook: async () => {
          throw new Error("webhook subscribe failed");
        },
        receivePayment: async () => {
          receiveCalls += 1;
          return { paymentRequest: SPEC_INVOICE };
        },
      }),
    }),
  });

  await expect(
    minter.createInvoice({
      receiverIdentityPubkey: "02" + "ab".repeat(32),
      amountSats: 21,
      memo: "booking",
    }),
  ).rejects.toThrow(/webhook subscribe failed/);
  expect(receiveCalls).toEqual(0);
});
