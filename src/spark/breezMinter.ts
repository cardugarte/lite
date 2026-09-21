import { paymentHashFromBolt11 } from "./bolt11.ts";
import { type SparkMinter } from "./minter.ts";

type BreezSdk = {
  registerWebhook(request: {
    url: string;
    secret: string;
    eventTypes: Array<{ type: "lightningReceiveFinished" }>;
  }): Promise<{ webhookId: string }>;
  receivePayment(request: {
    paymentMethod: {
      type: "bolt11Invoice";
      description: string;
      amountSats: number;
      expirySecs?: number;
      paymentHash?: string;
      receiverIdentityPublicKey: string;
    };
  }): Promise<{ paymentRequest: string }>;
};

type BreezModule = {
  defaultConfig: (network: string) => { apiKey?: string };
  connect: (opts: {
    config: { apiKey?: string };
    seed: { type: "mnemonic"; mnemonic: string; passphrase?: string };
    storageDir: string;
  }) => Promise<BreezSdk>;
};

export function sparkReceiveWebhookUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/spark/webhook`;
}

export function resolveSparkWebhookUrl(baseUrl: string, override?: string): string {
  if (override && override.trim()) {
    return override.replace(/\/$/, "");
  }
  return sparkReceiveWebhookUrl(baseUrl);
}

export function createBreezSparkMinter(opts: {
  apiKey: string;
  mnemonic: string;
  webhookUrl: string;
  webhookSecret: string;
  storageDir?: string;
  loadBreez?: () => Promise<BreezModule>;
}): SparkMinter {
  let sdkPromise: Promise<BreezSdk> | null = null;

  async function sdk(): Promise<BreezSdk> {
    if (!sdkPromise) {
      sdkPromise = (async () => {
        const breez = opts.loadBreez
          ? await opts.loadBreez()
          : await import("npm:@breeztech/breez-sdk-spark@0.25.0/deno/breez_sdk_spark_wasm.js") as BreezModule;
        const config = breez.defaultConfig("mainnet");
        config.apiKey = opts.apiKey;
        const client = await breez.connect({
          config,
          seed: { type: "mnemonic", mnemonic: opts.mnemonic, passphrase: undefined },
          storageDir: opts.storageDir ?? "./.spark-minter",
        });
        await client.registerWebhook({
          url: opts.webhookUrl,
          secret: opts.webhookSecret,
          eventTypes: [{ type: "lightningReceiveFinished" }],
        });
        return client;
      })();
    }
    try {
      return await sdkPromise;
    } catch (error) {
      sdkPromise = null;
      throw error;
    }
  }

  return {
    async connect() {
      await sdk();
    },
    async createInvoice({ receiverIdentityPubkey, amountSats, memo }) {
      const client = await sdk();
      const response = await client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: memo,
          amountSats,
          expirySecs: undefined,
          paymentHash: undefined,
          receiverIdentityPublicKey: receiverIdentityPubkey,
        },
      });
      return {
        invoice: response.paymentRequest,
        paymentHash: paymentHashFromBolt11(response.paymentRequest),
      };
    },
  };
}
