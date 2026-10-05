import { logger } from "../logger.ts";
import { paymentHashFromBolt11 } from "./bolt11.ts";
import { deriveMinterDatabaseUrl } from "./minterDatabase.ts";
import { type SparkMinter, type SparkWebhook } from "./minter.ts";
import type { SparkIdentitySigner } from "./ssp.ts";

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

type BreezSeed = { type: "mnemonic"; mnemonic: string; passphrase?: string };

type PostgresStorageConfig = {
  connectionString: string;
  maxPoolSize: number;
  createTimeoutSecs: number;
  recycleTimeoutSecs: number;
};

/** The part of the SDK's `./nodejs` entry the minter uses. */
type BreezModule = {
  defaultConfig: (network: string) => BreezConfig;
  postgresStorage: (config: PostgresStorageConfig) => unknown;
  SdkBuilder: {
    new: (config: BreezConfig, seed: BreezSeed) => {
      withStorageBackend: (storage: unknown) => { build: () => Promise<BreezSdk> };
    };
  };
};

/** The part of the SDK's `./nodejs` entry that derives the identity signer. */
type BreezSignerModule = {
  defaultExternalSigners: (
    mnemonic: string,
    passphrase: string | undefined,
    network: string,
  ) => { sparkSigner: SparkIdentitySigner };
};

// A small pool: the minter makes few concurrent calls and shares the database
// with the app.
const STORAGE_POOL = { maxPoolSize: 2, createTimeoutSecs: 10, recycleTimeoutSecs: 60 } as const;

export function sparkReceiveWebhookUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/spark/webhook`;
}

export function resolveSparkWebhookUrl(baseUrl: string, override?: string): string {
  if (override && override.trim()) {
    // Compared as an exact string against the registered webhooks: never rewritten.
    return override.trim();
  }
  return sparkReceiveWebhookUrl(baseUrl);
}

export function createBreezSparkMinter(opts: {
  apiKey: string;
  mnemonic: string;
  webhookUrl: string;
  webhookSecret: string;
  /** The app's DATABASE_URL; the minter derives its own connection string from it. */
  databaseUrl: string;
  /** Optional explicit minter connection string (SPARK_MINTER_DATABASE_URL). */
  databaseUrlOverride?: string;
  loadBreez?: () => Promise<BreezModule>;
}): SparkMinter {
  // Connecting and syncing the webhook are separate steps. A failed webhook
  // step is retried on the already connected SDK instead of connecting again.
  let connecting: Promise<BreezSdk> | null = null;
  let ready: Promise<BreezSdk> | null = null;

  async function connectClient(): Promise<BreezSdk> {
    // The Deno build of the SDK has no default storage and crashes the
    // process at connect; the Node entry (CJS, so `default` may carry the
    // exports) works under `deno run` and in the compiled binary.
    const breez = opts.loadBreez
      ? await opts.loadBreez()
      : await loadNodeEntry();
    const config = breez.defaultConfig("mainnet");
    config.apiKey = opts.apiKey;
    // The minter only mints. Without an LNURL domain the SDK performs no
    // `recover` against its default breez.tips at connect.
    config.lnurlDomain = undefined;
    const storage = breez.postgresStorage({
      connectionString: deriveMinterDatabaseUrl(opts.databaseUrl, opts.databaseUrlOverride),
      ...STORAGE_POOL,
    });
    const client = await breez.SdkBuilder
      .new(config, { type: "mnemonic", mnemonic: opts.mnemonic, passphrase: undefined })
      .withStorageBackend(storage)
      .build();
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
    async createInvoice({ receiverIdentityPubkey, amountSats, memo, expirySecs }) {
      const client = await sdk();
      const response = await client.receivePayment({
        paymentMethod: {
          type: "bolt11Invoice",
          description: memo,
          amountSats,
          expirySecs,
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

async function loadNodeEntry(): Promise<BreezModule & BreezSignerModule> {
  const mod = await import("npm:@breeztech/breez-sdk-spark@0.25.0/nodejs") as unknown as
    & { default?: BreezModule & BreezSignerModule }
    & BreezModule
    & BreezSignerModule;
  return mod.default ?? mod;
}

/**
 * The minter's Spark identity signer: the SDK's signer handle, derived offline
 * from the minter mnemonic. It is the identity the minter connects with. Lite
 * uses it to sign the SSP's authentication challenge and nothing else. The SDK
 * loads on first use and the handle is kept; a failed load is retried by the
 * next call.
 */
export function createBreezIdentitySigner(opts: {
  mnemonic: string;
  loadBreez?: () => Promise<BreezSignerModule>;
}): () => Promise<SparkIdentitySigner> {
  let signer: Promise<SparkIdentitySigner> | null = null;
  return () => {
    signer ??= (async () => {
      const breez = opts.loadBreez ? await opts.loadBreez() : await loadNodeEntry();
      return breez.defaultExternalSigners(opts.mnemonic, undefined, "mainnet").sparkSigner;
    })().catch((error) => {
      signer = null;
      throw error;
    });
    return signer;
  };
}

/** Removes every secret and any connection-string credentials from an error message. */
export function sanitizeErrorMessage(message: string, secrets: string[]): string {
  let clean = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]*@/gi, "$1[redacted]@");
  for (const secret of secrets) {
    if (secret) clean = clean.split(secret).join("[redacted]");
  }
  return clean;
}

/**
 * Connects the minter in the background. It never rejects: a failed warmup is
 * logged (error name and a message without secrets) and the process keeps
 * serving, minting retries the connect on first use.
 */
export async function warmUpSparkMinter(minter: SparkMinter, secrets: string[]): Promise<void> {
  try {
    await minter.connect?.();
  } catch (error) {
    logger.error("spark minter warmup failed", {
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: sanitizeErrorMessage(error instanceof Error ? error.message : String(error), secrets),
    });
  }
}
