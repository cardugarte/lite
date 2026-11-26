import { buildApp } from "./app.ts";
import {
  APP_ORIGINS,
  BASE_URL,
  BREEZ_API_KEY,
  DATABASE_URL,
  PORT,
  SPARK_MINTER_DATABASE_URL,
  SPARK_MINTER_MNEMONIC,
  SPARK_WEBHOOK_SECRET,
} from "./constants.ts";
import { DB, runMigration } from "./db/db.ts";
import { LOG_LEVEL, logger } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import { createSettlementNotifier } from "./settlement-notice.ts";
import {
  createBreezIdentitySigner,
  createBreezSparkMinter,
  resolveSparkWebhookUrl,
  warmUpSparkMinter,
} from "./spark/breezMinter.ts";
import { createSparkReconciler } from "./spark/reconcile.ts";
import { createSspClient } from "./spark/ssp.ts";

await runMigration();

// The first time an app-minted booking invoice is recorded as settled, the app is told so it can
// re-verify. Fire-and-forget: the notifier never throws and never blocks a settlement.
const settlementNotifier = createSettlementNotifier({ origins: APP_ORIGINS });
const db = new DB(DATABASE_URL, { onFirstSettlement: settlementNotifier.notify });
const nwcPool = new NWCPool(db);
await nwcPool.init();
const sparkMinter = BREEZ_API_KEY && SPARK_MINTER_MNEMONIC && SPARK_WEBHOOK_SECRET
  ? createBreezSparkMinter({
    apiKey: BREEZ_API_KEY,
    mnemonic: SPARK_MINTER_MNEMONIC,
    webhookUrl: resolveSparkWebhookUrl(BASE_URL, Deno.env.get("SPARK_WEBHOOK_URL") ?? undefined),
    webhookSecret: SPARK_WEBHOOK_SECRET,
    databaseUrl: DATABASE_URL,
    databaseUrlOverride: SPARK_MINTER_DATABASE_URL,
  })
  : undefined;
if (sparkMinter) {
  // Never rejects: a failed warmup is logged without secrets and the server keeps serving.
  void warmUpSparkMinter(sparkMinter, [
    BREEZ_API_KEY,
    SPARK_MINTER_MNEMONIC,
    SPARK_WEBHOOK_SECRET,
    DATABASE_URL,
    SPARK_MINTER_DATABASE_URL ?? "",
  ]);
}

// A paid Spark invoice whose webhook was lost is settled from the SSP list when
// someone asks for its status. It exists wherever the minter does.
const sparkReconciler = sparkMinter
  ? createSparkReconciler({
    db,
    ssp: createSspClient({ getSigner: createBreezIdentitySigner({ mnemonic: SPARK_MINTER_MNEMONIC }) }),
  })
  : undefined;

const hono = buildApp({
  db,
  nwcPool,
  sparkMinter,
  sparkReconciler,
  sparkWebhookSecret: SPARK_WEBHOOK_SECRET,
});

Deno.serve({ port: PORT }, hono.fetch);

logger.info("Server started", { port: PORT, log_level: LOG_LEVEL });
