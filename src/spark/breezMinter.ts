import { paymentHashFromBolt11 } from "./bolt11.ts";
import { BREEZ_SDK_SPARK_DENO_SPECIFIER, type SparkMinter } from "./minter.ts";

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
          : await import(BREEZ_SDK_SPARK_DENO_SPECIFIER) as BreezModule;
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
    return sdkPromise;
  }

  return {
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
