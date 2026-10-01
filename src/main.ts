import { buildApp } from "./app.ts";
import { BASE_URL, BREEZ_API_KEY, PORT, SPARK_MINTER_MNEMONIC, SPARK_MINTER_STORAGE_DIR, SPARK_WEBHOOK_SECRET } from "./constants.ts";
import { DB, runMigration } from "./db/db.ts";
import { LOG_LEVEL, logger } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import { createBreezSparkMinter, resolveSparkWebhookUrl } from "./spark/breezMinter.ts";

await runMigration();

const db = new DB();
const nwcPool = new NWCPool(db);
await nwcPool.init();
const sparkMinter = BREEZ_API_KEY && SPARK_MINTER_MNEMONIC && SPARK_WEBHOOK_SECRET
  ? createBreezSparkMinter({
    apiKey: BREEZ_API_KEY,
    mnemonic: SPARK_MINTER_MNEMONIC,
    webhookUrl: resolveSparkWebhookUrl(BASE_URL, Deno.env.get("SPARK_WEBHOOK_URL") ?? undefined),
    webhookSecret: SPARK_WEBHOOK_SECRET,
    storageDir: SPARK_MINTER_STORAGE_DIR,
  })
  : undefined;
if (sparkMinter?.connect) {
  void sparkMinter.connect().catch((error) => {
    logger.error("spark minter warmup failed", { error });
  });
}

const hono = buildApp({
  db,
  nwcPool,
  sparkMinter,
  sparkWebhookSecret: SPARK_WEBHOOK_SECRET,
});

Deno.serve({ port: PORT }, hono.fetch);

logger.info("Server started", { port: PORT, log_level: LOG_LEVEL });
