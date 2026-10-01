import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { captureLogs, entriesFor } from "../test_logs.ts";
import {
  createBreezSparkMinter,
  resolveSparkWebhookUrl,
  sparkReceiveWebhookUrl,
} from "./breezMinter.ts";

const SPEC_INVOICE =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";

const WEBHOOK_URL = "http://lnaddr.test/spark/webhook";
const WEBHOOK_SECRET = "spark-webhook-secret";

Deno.test("main.ts subscribes the minter webhook to the shipped handler", () => {
  const src = Deno.readTextFileSync(new URL("../main.ts", import.meta.url));
  const app = Deno.readTextFileSync(new URL("../app.ts", import.meta.url));
  expect(src.includes("resolveSparkWebhookUrl(BASE_URL")).toEqual(true);
  expect(src.includes("webhookSecret: SPARK_WEBHOOK_SECRET")).toEqual(true);
  expect(src.includes("buildApp(")).toEqual(true);
  expect(app.includes('hono.route("/spark/webhook"')).toEqual(true);
});

Deno.test("the minter webhook URL resolves from the importable BASE_URL", async () => {
  const { BASE_URL } = await import("../constants.ts");
  // Compile-time guard for src/main.ts:25: this fails to type-check if BASE_URL
  // is typed `string | undefined` instead of the guaranteed present string.
  const baseUrl: string = BASE_URL;
  expect(resolveSparkWebhookUrl(baseUrl)).toEqual(sparkReceiveWebhookUrl(baseUrl));
});

Deno.test("readEnvValue treats missing and blank values as absent", async () => {
  const { readEnvValue } = await import("../constants.ts");
  expect(readEnvValue(undefined)).toEqual(undefined);
  expect(readEnvValue("")).toEqual(undefined);
  expect(readEnvValue("   ")).toEqual(undefined);
  expect(readEnvValue("  http://lnaddr.test  ")).toEqual("http://lnaddr.test");
});

Deno.test("imported BASE_URL is a trimmed, non-blank string", async () => {
  const { BASE_URL, readEnvValue } = await import("../constants.ts");
  // A missing or blank env value never reaches the minter: the module exits first.
  expect(readEnvValue(BASE_URL)).toEqual(BASE_URL);
  expect(BASE_URL.trim()).toEqual(BASE_URL);
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
          listWebhooks: async () => [],
          unregisterWebhook: async () => {},
          getInfo: async () => ({ balanceSats: 0 }),
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
  expect(minted.receiverPubkey).toEqual("02" + "ab".repeat(32));
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
        listWebhooks: async () => [],
          unregisterWebhook: async () => {},
        getInfo: async () => ({ balanceSats: 0 }),
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

Deno.test("retries connect after a failed first sdk() instead of caching the rejection", async () => {
  let connects = 0;
  const minter = createBreezSparkMinter({
    apiKey: "test-api-key",
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    webhookUrl: WEBHOOK_URL,
    webhookSecret: WEBHOOK_SECRET,
    loadBreez: async () => ({
      defaultConfig: () => ({ apiKey: undefined }),
      connect: async () => {
        connects += 1;
        if (connects === 1) throw new Error("ssp down");
        return {
          listWebhooks: async () => [],
          unregisterWebhook: async () => {},
          getInfo: async () => ({ balanceSats: 0 }),
          registerWebhook: async () => ({ webhookId: "wh-2" }),
          receivePayment: async () => ({ paymentRequest: SPEC_INVOICE }),
        };
      },
    }),
  });

  await expect(
    minter.createInvoice({
      receiverIdentityPubkey: "02" + "ab".repeat(32),
      amountSats: 21,
      memo: "booking",
    }),
  ).rejects.toThrow(/ssp down/);

  const minted = await minter.createInvoice({
    receiverIdentityPubkey: "02" + "ab".repeat(32),
    amountSats: 21,
    memo: "booking",
  });
  expect(connects).toEqual(2);
  expect(minted.invoice).toEqual(SPEC_INVOICE);
});

Deno.test("production load uses a string-literal Deno WASM specifier", () => {
  const src = Deno.readTextFileSync(new URL("./breezMinter.ts", import.meta.url));
  expect(src.includes('import("npm:@breeztech/breez-sdk-spark@0.25.0/deno/breez_sdk_spark_wasm.js")'))
    .toEqual(true);
  expect(src.includes("import(BREEZ_SDK_SPARK_DENO_SPECIFIER)")).toEqual(false);
});

Deno.test("resolveSparkWebhookUrl keeps a configured URL verbatim, trailing slash included", () => {
  expect(resolveSparkWebhookUrl("https://travelsats.ar", "https://lite.fly.dev/spark/webhook/"))
    .toEqual("https://lite.fly.dev/spark/webhook/");
  expect(resolveSparkWebhookUrl("https://travelsats.ar", "  https://lite.fly.dev/spark/webhook  "))
    .toEqual("https://lite.fly.dev/spark/webhook");
});

Deno.test("a configured URL with a trailing slash matches a listed webhook with that exact string", async () => {
  const configured = resolveSparkWebhookUrl("https://travelsats.ar", "https://lite.fly.dev/spark/webhook/");
  const registered: unknown[] = [];
  const instance = createBreezSparkMinter({
    apiKey: "k",
    mnemonic: "m",
    webhookUrl: configured,
    webhookSecret: WEBHOOK_SECRET,
    loadBreez: (async () => ({
      defaultConfig: () => ({}),
      connect: async () => ({
        listWebhooks: async () => [{ id: "w1", url: "https://lite.fly.dev/spark/webhook/", eventTypes: [] }],
        unregisterWebhook: async () => {},
        registerWebhook: async (request: unknown) => {
          registered.push(request);
          return { webhookId: "new" };
        },
        getInfo: async () => ({ balanceSats: 0 }),
        receivePayment: async () => ({ paymentRequest: SPEC_INVOICE }),
      }),
    })) as never,
  });
  await captureLogs(() => instance.connect!());
  expect(registered).toEqual([]);
});

Deno.test("resolveSparkWebhookUrl prefers an explicit Fly origin over BASE_URL", async () => {
  const { resolveSparkWebhookUrl } = await import("./breezMinter.ts");
  expect(resolveSparkWebhookUrl("https://travelsats.ar", "https://lite.fly.dev/spark/webhook"))
    .toEqual("https://lite.fly.dev/spark/webhook");
  expect(resolveSparkWebhookUrl("https://travelsats.ar")).toEqual(
    "https://travelsats.ar/spark/webhook",
  );
});

// ---------------------------------------------------------------------------
// L10: the webhook is registered once, the minter has no LNURL client, and it
// reports its balance.
// ---------------------------------------------------------------------------

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECEIVER = "02" + "ab".repeat(32);

type ListedWebhook = { id: string; url: string; eventTypes: Array<{ type: string }> };
type Spies = {
  connects: number;
  lists: number;
  registered: Array<{ url: string; secret: string; eventTypes: Array<{ type: string }> }>;
  unregistered: string[];
  configs: Array<Record<string, unknown>>;
  paymentLookups: string[];
};

function sdkWorld(options: {
  webhooks?: () => Promise<ListedWebhook[]>;
  balance?: number;
  defaultConfig?: Record<string, unknown>;
  connectDelayMs?: number;
} = {}) {
  const spies: Spies = {
    connects: 0,
    lists: 0,
    registered: [],
    unregistered: [],
    configs: [],
    paymentLookups: [],
  };
  const loadBreez = async () => ({
    defaultConfig: () => ({ apiKey: undefined, lnurlDomain: "breez.tips", ...options.defaultConfig }),
    connect: async (opts: { config: Record<string, unknown> }) => {
      spies.connects += 1;
      spies.configs.push({ ...opts.config });
      if (options.connectDelayMs) await new Promise((resolve) => setTimeout(resolve, options.connectDelayMs));
      return {
        listWebhooks: async () => {
          spies.lists += 1;
          return options.webhooks ? await options.webhooks() : [];
        },
        registerWebhook: async (request: Spies["registered"][number]) => {
          spies.registered.push(request);
          return { webhookId: "wh-new" };
        },
        unregisterWebhook: async (request: { webhookId: string }) => {
          spies.unregistered.push(request.webhookId);
        },
        getInfo: async () => ({ balanceSats: options.balance ?? 0 }),
        receivePayment: async () => ({ paymentRequest: SPEC_INVOICE }),
        // The minter must never use these: settlement is webhook-only.
        getPayment: async () => {
          spies.paymentLookups.push("getPayment");
          return {};
        },
        listPayments: async () => {
          spies.paymentLookups.push("listPayments");
          return { payments: [] };
        },
      };
    },
  });
  const minter = () =>
    createBreezSparkMinter({
      apiKey: "test-api-key",
      mnemonic: MNEMONIC,
      webhookUrl: WEBHOOK_URL,
      webhookSecret: WEBHOOK_SECRET,
      loadBreez: loadBreez as never,
    });
  return { spies, minter };
}

const mint = (minter: ReturnType<typeof createBreezSparkMinter>) =>
  minter.createInvoice({ receiverIdentityPubkey: RECEIVER, amountSats: 21, memo: "booking" });

Deno.test("an empty webhook list registers once and logs spark_webhook_registered", async () => {
  const { spies, minter } = sdkWorld();
  const { entries } = await captureLogs(() => minter().connect!());
  expect(spies.registered).toEqual([{
    url: WEBHOOK_URL,
    secret: WEBHOOK_SECRET,
    eventTypes: [{ type: "lightningReceiveFinished" }],
  }]);
  expect(spies.unregistered).toEqual([]);
  expect(entriesFor(entries, "spark_webhook_registered").length).toEqual(1);
  expect(entriesFor(entries, "spark_webhook_stale")).toEqual([]);
});

Deno.test("an existing same-URL webhook is reused: no register, no unregister", async () => {
  const { spies, minter } = sdkWorld({
    webhooks: async () => [{ id: "w1", url: WEBHOOK_URL, eventTypes: [{ type: "lightningReceiveFinished" }] }],
  });
  const { entries, raw } = await captureLogs(() => minter().connect!());
  expect(spies.registered).toEqual([]);
  expect(spies.unregistered).toEqual([]);
  expect(entriesFor(entries, "spark_webhook_already_registered").length).toEqual(1);
  expect(raw).not.toContain(WEBHOOK_SECRET);
});

Deno.test("duplicate same-URL webhooks are trimmed to the first listed", async () => {
  const { spies, minter } = sdkWorld({
    webhooks: async () => [
      { id: "w1", url: WEBHOOK_URL, eventTypes: [] },
      { id: "w2", url: WEBHOOK_URL, eventTypes: [] },
    ],
  });
  await captureLogs(() => minter().connect!());
  expect(spies.unregistered).toEqual(["w2"]);
  expect(spies.registered).toEqual([]);
});

Deno.test("other URLs are reported once and never deleted, and a different URL registers", async () => {
  const { spies, minter } = sdkWorld({
    webhooks: async () => [{ id: "stale-1", url: "https://other.example/spark/webhook", eventTypes: [] }],
  });
  const { entries } = await captureLogs(() => minter().connect!());
  expect(spies.registered.length).toEqual(1);
  expect(spies.unregistered).toEqual([]);
  const stale = entriesFor(entries, "spark_webhook_stale");
  expect(stale.length).toEqual(1);
  expect(stale[0].level).toEqual("WARN");
  expect(stale[0].args?.webhook_ids).toEqual(["stale-1"]);
});

Deno.test("a trailing-slash variant of the URL is another URL", async () => {
  const { spies, minter } = sdkWorld({
    webhooks: async () => [{ id: "slash", url: WEBHOOK_URL + "/", eventTypes: [] }],
  });
  const { entries } = await captureLogs(() => minter().connect!());
  expect(spies.registered.length).toEqual(1);
  expect(spies.unregistered).toEqual([]);
  expect(entriesFor(entries, "spark_webhook_stale")[0].args?.webhook_ids).toEqual(["slash"]);
});

Deno.test("a restarted minter against a list that holds the webhook registers zero times", async () => {
  const listed: ListedWebhook[] = [];
  const { spies, minter } = sdkWorld({ webhooks: async () => listed });
  await captureLogs(() => minter().connect!());
  expect(spies.registered.length).toEqual(1);
  listed.push({ id: "wh-new", url: WEBHOOK_URL, eventTypes: [{ type: "lightningReceiveFinished" }] });
  await captureLogs(() => minter().connect!());
  expect(spies.registered.length).toEqual(1);
  expect(spies.connects).toEqual(2);
});

Deno.test("a rejecting listWebhooks rejects connect, never registers, and a later connect retries", async () => {
  let failing = true;
  const { spies, minter } = sdkWorld({
    webhooks: async () => {
      if (failing) throw new Error("ssp unavailable");
      return [];
    },
  });
  const instance = minter();
  await expect(captureLogs(() => instance.connect!())).rejects.toThrow(/ssp unavailable/);
  expect(spies.registered).toEqual([]);
  failing = false;
  await captureLogs(() => instance.connect!());
  expect(spies.lists).toEqual(2);
  expect(spies.registered.length).toEqual(1);
  // The connected SDK is kept: only the webhook step is retried.
  expect(spies.connects).toEqual(1);
});

Deno.test("two simultaneous createInvoice calls share one connect, one list, and one registration", async () => {
  const { spies, minter } = sdkWorld({ connectDelayMs: 10 });
  const instance = minter();
  const [a, b] = await captureLogs(() => Promise.all([mint(instance), mint(instance)])).then((r) => r.result);
  expect(a.invoice).toEqual(SPEC_INVOICE);
  expect(b.invoice).toEqual(SPEC_INVOICE);
  expect(spies.connects).toEqual(1);
  expect(spies.lists).toEqual(1);
  expect(spies.registered.length).toEqual(1);
});

Deno.test("the minter has no LNURL client even when the SDK default sets one", async () => {
  const { spies, minter } = sdkWorld();
  await captureLogs(() => minter().connect!());
  expect(spies.configs.length).toEqual(1);
  expect(spies.configs[0].lnurlDomain).toBeUndefined();
  expect("lnurlDomain" in spies.configs[0]).toEqual(true);
  expect(spies.configs[0].apiKey).toEqual("test-api-key");
});

Deno.test("connect logs the minter balance once", async () => {
  const { minter } = sdkWorld({ balance: 1234 });
  const { entries } = await captureLogs(() => minter().connect!());
  const balance = entriesFor(entries, "spark_minter_balance");
  expect(balance.length).toEqual(1);
  expect(balance[0].args?.balanceSats).toEqual(1234);
});

Deno.test("a failing balance read never blocks connect or minting", async () => {
  const instance = createBreezSparkMinter({
    apiKey: "test-api-key",
    mnemonic: MNEMONIC,
    webhookUrl: WEBHOOK_URL,
    webhookSecret: WEBHOOK_SECRET,
    loadBreez: (async () => ({
      defaultConfig: () => ({}),
      connect: async () => ({
        listWebhooks: async () => [],
        registerWebhook: async () => ({ webhookId: "wh" }),
        getInfo: async () => {
          throw new Error("sync pending");
        },
        receivePayment: async () => ({ paymentRequest: SPEC_INVOICE }),
      }),
    })) as never,
  });
  const { result } = await captureLogs(() => mint(instance));
  expect(result.invoice).toEqual(SPEC_INVOICE);
});

Deno.test("minting echoes the receiver key and never looks a payment up in the SDK", async () => {
  const { spies, minter } = sdkWorld();
  const { result } = await captureLogs(() => mint(minter()));
  expect(result.receiverPubkey).toEqual(RECEIVER);
  expect(spies.paymentLookups).toEqual([]);
});
