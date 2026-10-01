import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { secureHeaders } from "hono/secure-headers";
import { DB } from "./db/db.ts";
import { createLnurlApp } from "./lnurlp.ts";
import { loggerMiddleware } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import type { SparkMinter } from "./spark/minter.ts";
import { createSparkWebhookApp } from "./spark/webhook.ts";
import { createUsersApp } from "./users.ts";
import { createLnurlWellKnownApp, createNostrWellKnownApp } from "./well-known/index.ts";

export type AppDeps = {
  db: DB;
  nwcPool: NWCPool;
  sparkMinter?: SparkMinter;
  sparkWebhookSecret: string;
};

export function buildApp(deps: AppDeps) {
  const hono = new Hono();
  hono.use(loggerMiddleware());
  hono.use(secureHeaders());

  const publicCors = cors();
  hono.use("/.well-known/lnurlp/*", publicCors);
  hono.use("/.well-known/nostr.json", publicCors);
  hono.use("/lnurlp/*", publicCors);

  hono.route("/.well-known/lnurlp", createLnurlWellKnownApp(deps.db));
  hono.route("/.well-known/nostr.json", createNostrWellKnownApp(deps.db));
  hono.route("/lnurlp", createLnurlApp(deps.db, deps.sparkMinter));
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
