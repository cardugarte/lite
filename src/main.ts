import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { secureHeaders } from "hono/secure-headers";
//import { sentry } from "npm:@hono/sentry";
import { BASE_URL, BREEZ_API_KEY, PORT, SPARK_MINTER_MNEMONIC, SPARK_MINTER_STORAGE_DIR, SPARK_WEBHOOK_SECRET } from "./constants.ts";
import { DB, runMigration } from "./db/db.ts";
import { createLnurlApp } from "./lnurlp.ts";
import { LOG_LEVEL, logger, loggerMiddleware } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import { createBreezSparkMinter, resolveSparkWebhookUrl } from "./spark/breezMinter.ts";
import { createSparkWebhookApp } from "./spark/webhook.ts";
import { createUsersApp } from "./users.ts";
import { createLnurlWellKnownApp, createNostrWellKnownApp } from "./well-known/index.ts";

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

// TODO: re-enable sentry
//const SENTRY_DSN = Deno.env.get("SENTRY_DSN");

const hono = new Hono();

hono.use(loggerMiddleware());
hono.use(secureHeaders());
hono.use(cors());
/*if (SENTRY_DSN) {
  hono.use("*", sentry({ dsn: SENTRY_DSN }));
}*/

hono.route("/.well-known/lnurlp", createLnurlWellKnownApp(db));
hono.route("/.well-known/nostr.json", createNostrWellKnownApp(db));
hono.route("/lnurlp", createLnurlApp(db, sparkMinter));
hono.route("/users", createUsersApp(db, nwcPool));
hono.route("/spark/webhook", createSparkWebhookApp(db, SPARK_WEBHOOK_SECRET));

hono.get("/ping", (c) => {
  return c.body("OK");
});

hono.use("/favicon.ico", serveStatic({ path: "./favicon.ico" }));

hono.get("/robots.txt", (c) => {
  return c.body("User-agent: *\nDisallow: /", 200);
});

Deno.serve({ port: PORT }, hono.fetch);

logger.info("Server started", { port: PORT, log_level: LOG_LEVEL });
