import { logger } from "../logger.ts";
import { paymentHashFromBolt11 } from "./bolt11.ts";
import { type SparkMinter, type SparkWebhook } from "./minter.ts";

type BreezSdk = {
  listWebhooks(): Promise<SparkWebhook[]>;
  unregisterWebhook(request: { webhookId: string }): Promise<void>;
  getInfo(request: { ensureSynced?: boolean }): Promise<{ balanceSats: number }>;
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

type BreezConfig = { apiKey?: string; lnurlDomain?: string };

type BreezModule = {
  defaultConfig: (network: string) => BreezConfig;
  connect: (opts: {
    config: BreezConfig;
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
  // Connecting and syncing the webhook are separate steps. A failed webhook
  // step is retried on the already connected SDK instead of connecting again.
  let connecting: Promise<BreezSdk> | null = null;
  let ready: Promise<BreezSdk> | null = null;

  async function connectClient(): Promise<BreezSdk> {
    const breez = opts.loadBreez
      ? await opts.loadBreez()
      : await import("npm:@breeztech/breez-sdk-spark@0.25.0/deno/breez_sdk_spark_wasm.js") as BreezModule;
    const config = breez.defaultConfig("mainnet");
    config.apiKey = opts.apiKey;
    // The minter only mints. Without an LNURL domain the SDK performs no
    // `recover` against its default breez.tips at connect.
    config.lnurlDomain = undefined;
    const client = await breez.connect({
      config,
      seed: { type: "mnemonic", mnemonic: opts.mnemonic, passphrase: undefined },
      storageDir: opts.storageDir ?? "./.spark-minter",
    });
    await logBalance(client);
    return client;
  }

  // A balance that rises while the device's does not would mean funds went to
  // the minter. A failed read never blocks minting.
  async function logBalance(client: BreezSdk): Promise<void> {
    try {
      const info = await client.getInfo({ ensureSynced: true });
      logger.info("spark minter balance", { event: "spark_minter_balance", balanceSats: info.balanceSats });
    } catch (error) {
      logger.warn("spark minter balance unavailable", {
        event: "spark_minter_balance_unavailable",
        errorName: error instanceof Error ? error.name : "Error",
      });
    }
  }

  // Register once: reuse a webhook with this exact URL, trim same-URL
  // duplicates, report other URLs without deleting them (environments might
  // share a seed by mistake; the runbook cleans them).
  async function syncWebhook(client: BreezSdk): Promise<void> {
    const listed = await client.listWebhooks();
    const same = listed.filter((webhook) => webhook.url === opts.webhookUrl);
    const others = listed.filter((webhook) => webhook.url !== opts.webhookUrl);
    if (same.length > 0) {
      for (const duplicate of same.slice(1)) {
        await client.unregisterWebhook({ webhookId: duplicate.id });
      }
      logger.info("spark webhook already registered", {
        event: "spark_webhook_already_registered",
        webhook_id: same[0].id,
        duplicates_removed: same.length - 1,
      });
    } else {
      const { webhookId } = await client.registerWebhook({
        url: opts.webhookUrl,
        secret: opts.webhookSecret,
        eventTypes: [{ type: "lightningReceiveFinished" }],
      });
      logger.info("spark webhook registered", { event: "spark_webhook_registered", webhook_id: webhookId });
    }
    if (others.length > 0) {
      logger.warn("spark webhooks with other urls exist", {
        event: "spark_webhook_stale",
        webhook_ids: others.map((webhook) => webhook.id),
      });
    }
  }

  async function sdk(): Promise<BreezSdk> {
    if (!ready) {
      ready = (async () => {
        connecting ??= connectClient().catch((error) => {
          connecting = null;
          throw error;
        });
        const client = await connecting;
        await syncWebhook(client);
        return client;
      })();
    }
    try {
      return await ready;
    } catch (error) {
      ready = null;
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
        receiverPubkey: receiverIdentityPubkey,
      };
    },
  };
}
