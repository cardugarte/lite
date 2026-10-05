import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { secureHeaders } from "hono/secure-headers";
import { APP_ORIGINS, LNURL_DOMAIN } from "./constants.ts";
import { DB } from "./db/db.ts";
import { createLnurlApp } from "./lnurlp.ts";
import { createLnurlpayCors } from "./lnurlpay/cors.ts";
import { createLnurlpayApp, PAYLOAD_TOO_LARGE } from "./lnurlpay/routes.ts";
import { loggerMiddleware } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import type { SparkMinter } from "./spark/minter.ts";
import type { SparkReconciler } from "./spark/reconcile.ts";
import { createSparkWebhookApp } from "./spark/webhook.ts";
import { createUsersApp } from "./users.ts";
import { createLnurlWellKnownApp, createNostrWellKnownApp } from "./well-known/index.ts";

export type AppDeps = {
  db: DB;
  nwcPool: NWCPool;
  sparkMinter?: SparkMinter;
  /** Settles a Spark invoice whose webhook was lost, from the SSP list. Built where the minter is. */
  sparkReconciler?: SparkReconciler;
  sparkWebhookSecret: string;
  /** Origins allowed to call `/lnurlpay/*` from a browser. Defaults to `APP_ORIGINS`. */
  appOrigins?: string[];
  /** The signed and published LNURL domain. Defaults to `LNURL_DOMAIN`. */
  lnurlDomain?: string;
  /** Lite's clock for `/lnurlpay/*` and `/lnurlp/*`. */
  now?: () => Date;
  /** Seconds an invoice stays payable. Defaults to the `INVOICE_EXPIRY_SECS` setting. */
  invoiceExpirySecs?: number;
};

const LNURLPAY_BODY_LIMIT_BYTES = 4096;

export function buildApp(deps: AppDeps) {
  const hono = new Hono();
  hono.use(loggerMiddleware());
  hono.use(secureHeaders());

  const publicCors = cors();
  hono.use("/.well-known/lnurlp/*", publicCors);
  hono.use("/.well-known/nostr.json", publicCors);
  hono.use("/lnurlp/*", publicCors);

  // Order matters: CORS first, so a preflight is answered before any body
  // handling and a 413 to a listed origin still carries the allow-origin header.
  hono.use("/lnurlpay/*", createLnurlpayCors(deps.appOrigins ?? APP_ORIGINS));
  hono.use(
    "/lnurlpay/*",
    bodyLimit({
      maxSize: LNURLPAY_BODY_LIMIT_BYTES,
      onError: (c) => c.json(PAYLOAD_TOO_LARGE, 413),
    }),
  );

  hono.route("/.well-known/lnurlp", createLnurlWellKnownApp(deps.db));
  hono.route("/.well-known/nostr.json", createNostrWellKnownApp(deps.db));
  hono.route(
    "/lnurlp",
    createLnurlApp(deps.db, deps.sparkMinter, deps.now, {
      invoiceExpirySecs: deps.invoiceExpirySecs,
      sparkReconciler: deps.sparkReconciler,
    }),
  );
  hono.route(
    "/lnurlpay",
    createLnurlpayApp({
      repo: deps.db,
      nwcPool: deps.nwcPool,
      domain: deps.lnurlDomain ?? LNURL_DOMAIN,
      now: deps.now ?? (() => new Date()),
    }),
  );
  hono.route("/users", createUsersApp(deps.db, deps.nwcPool));
  hono.route("/spark/webhook", createSparkWebhookApp(deps.db, deps.sparkWebhookSecret));

  hono.get("/ping", (c) => {
    return c.body("OK");
  });

  hono.use("/favicon.ico", serveStatic({ path: "./favicon.ico" }));

  hono.get("/robots.txt", (c) => {
    return c.body("User-agent: *\nDisallow: /", 200);
  });

  return hono;
}
