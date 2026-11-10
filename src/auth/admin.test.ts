import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import * as nodeCrypto from "node:crypto";
import { Hono } from "hono";
import { registrationCrypto } from "./bff.ts";
import { requireAdminToken } from "./admin.ts";
import { logger } from "../logger.ts";

const TOKEN = "admin-token-value";

function app() {
  const hono = new Hono();
  hono.get("/admin/reserved-usernames", (c) => {
    const denied = requireAdminToken(c);
    if (denied) return denied;
    return c.json({ ok: true });
  });
  return hono;
}

async function withToken<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("LITE_ADMIN_TOKEN");
  if (value === undefined) Deno.env.delete("LITE_ADMIN_TOKEN");
  else Deno.env.set("LITE_ADMIN_TOKEN", value);
  try {
    return await fn();
  } finally {
    if (previous == null) Deno.env.delete("LITE_ADMIN_TOKEN");
    else Deno.env.set("LITE_ADMIN_TOKEN", previous);
  }
}

function get(headers: Record<string, string> = {}) {
  return app().request("/admin/reserved-usernames", { headers });
}

Deno.test("admin routes fail closed with 401 when the token is unset, blank, or missing", async () => {
  for (const secret of [undefined, "", "   "]) {
    await withToken(secret, async () => {
      const missing = await get();
      const presented = await get({ Authorization: `Bearer ${TOKEN}` });
      expect(missing.status).toEqual(401);
      expect(await missing.json()).toEqual({ status: "ERROR", reason: "unauthorized" });
      expect(presented.status).toEqual(401);
      expect(await presented.json()).toEqual({ status: "ERROR", reason: "unauthorized" });
    });
  }
});

Deno.test("a missing or non-bearer admin header is 401 and a wrong token is 403", async () => {
  await withToken(TOKEN, async () => {
    const missing = await get();
    const basic = await get({ Authorization: `Basic ${TOKEN}` });
    const wrong = await get({ Authorization: "Bearer admin-token-valuX" });
    const differentLength = await get({ Authorization: "Bearer no" });
    expect(missing.status).toEqual(401);
    expect(basic.status).toEqual(401);
    expect(wrong.status).toEqual(403);
    expect(await wrong.json()).toEqual({ status: "ERROR", reason: "forbidden" });
    expect(differentLength.status).toEqual(403);
    const ok = await get({ Authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toEqual(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});

Deno.test("the admin token is compared in constant time and never logged", async () => {
  const calls: number[] = [];
  const original = registrationCrypto.timingSafeEqual;
  registrationCrypto.timingSafeEqual = (left, right) => {
    calls.push(left.byteLength);
    return nodeCrypto.timingSafeEqual(left, right);
  };
  const writable = logger as unknown as { levelName: string; handlers: Array<{ levelName: string }> };
  const previousLevel = writable.levelName;
  const previousHandlers = writable.handlers.map((handler) => handler.levelName);
  writable.levelName = "DEBUG";
  for (const handler of writable.handlers) handler.levelName = "DEBUG";
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  };
  try {
    await withToken(TOKEN, async () => {
      expect((await get({ Authorization: "Bearer admin-token-valuX" })).status).toEqual(403);
      expect((await get({ Authorization: "Bearer short" })).status).toEqual(403);
      expect((await get({ Authorization: `Bearer ${TOKEN}` })).status).toEqual(200);
    });
  } finally {
    console.log = originalLog;
    registrationCrypto.timingSafeEqual = original;
    writable.levelName = previousLevel;
    writable.handlers.forEach((handler, index) => {
      handler.levelName = previousHandlers[index];
    });
  }
  expect(calls).toEqual([TOKEN.length, TOKEN.length]);
  expect(lines.join("\n").includes(TOKEN)).toEqual(false);
});
