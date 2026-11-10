import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "./db/db.ts";
import { createUsernamesApp } from "./usernames.ts";
import {
  USERNAME_AVAILABILITY_RATE_LIMIT,
  USERNAME_AVAILABILITY_RATE_WINDOW_SECONDS,
  availabilityRateConfig,
} from "./usernames/rateLimit.ts";

const PUBKEY = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const NOW = new Date("2026-03-01T12:00:00.000Z");

function app(state: {
  reserved?: (name: string, pubkey: string | null) => boolean;
  taken?: Set<string>;
  intent?: Set<string>;
} = {}) {
  const calls: Array<{ name: string; pubkey: string | null }> = [];
  const db = {
    isReservedUsername: async (name: string, pubkey: string | null) => {
      calls.push({ name, pubkey });
      const normalized = name.trim().toLowerCase().replace(/[.\-_]/g, "");
      return state.reserved ? state.reserved(normalized, pubkey) : false;
    },
    findUserByUsername: async (name: string) => state.taken?.has(name) ? { username: name } : null,
    findActiveBindingIntent: async (name: string) => state.intent?.has(name) ? { nostrPubkey: OTHER, sparkPubkey: "02" + "ab".repeat(32) } : null,
  } as unknown as DB;
  return { app: createUsernamesApp(db, () => NOW), calls };
}

Deno.test("GET /usernames/:username/availability is false for invalid, taken, reserved, and unassigned names", async () => {
  const { app: hono, calls } = app({
    reserved: (name, pubkey) => name === "hello" || (name === "mendoza" && pubkey !== PUBKEY),
    taken: new Set(["alice"]),
    intent: new Set(["carol"]),
  });
  const cases: Array<{ path: string; available: boolean }> = [
    { path: "/ab/availability", available: false },
    { path: "/has%20space/availability", available: false },
    { path: "/hello/availability", available: false },
    { path: "/hel.lo/availability", available: false },
    { path: "/alice/availability", available: false },
    { path: "/carol/availability", available: false },
    { path: "/mendoza/availability", available: false },
    { path: `/mendoza/availability?pubkey=${OTHER}`, available: false },
    { path: `/mendoza/availability?pubkey=${PUBKEY}`, available: true },
    { path: "/andes/availability", available: true },
    { path: `/${"npub1qqqqqqqqqqqqq"}/availability`, available: false },
  ];
  for (const item of cases) {
    const res = await hono.request(item.path);
    expect({ path: item.path, status: res.status, body: await res.json() }).toEqual({
      path: item.path,
      status: 200,
      body: { available: item.available },
    });
    const again = await hono.request(item.path);
    const text = JSON.stringify(await again.json());
    expect(text.includes("reserved") || text.includes("taken") || text.includes("invalid")).toEqual(false);
  }
  expect(calls.some((call) => call.name === "ab")).toEqual(false);
  expect(calls.some((call) => call.name === "hello" && call.pubkey === null)).toEqual(true);
  expect(calls.some((call) => call.name === "hel.lo" && call.pubkey === null)).toEqual(true);
});

Deno.test("username availability uses the PWA user_profile budget unless the env overrides it", () => {
  expect(USERNAME_AVAILABILITY_RATE_LIMIT).toEqual(50);
  expect(USERNAME_AVAILABILITY_RATE_WINDOW_SECONDS).toEqual(60);
  expect(availabilityRateConfig({ get: () => undefined })).toEqual({ limit: 50, windowMs: 60_000 });
  expect(availabilityRateConfig({
    get: (name) => name === "USERNAME_AVAILABILITY_RATE_LIMIT" ? "2" : "60",
  })).toEqual({ limit: 2, windowMs: 60_000 });
});

Deno.test("GET /usernames/:username/availability rate-limits each client IP and resets", async () => {
  let nowMs = Date.parse("2026-03-01T12:00:00.000Z");
  const calls: string[] = [];
  const db = {
    isReservedUsername: async () => {
      calls.push("reserved");
      return false;
    },
    findUserByUsername: async () => null,
    findActiveBindingIntent: async () => null,
  } as unknown as DB;
  const hono = createUsernamesApp(db, () => new Date(nowMs), { limit: 2, windowMs: 60_000 });
  const ask = (ip: string, forwarded?: string) =>
    hono.request("/andes/availability", {
      headers: {
        "Fly-Client-IP": ip,
        ...(forwarded ? { "X-Forwarded-For": forwarded } : {}),
      },
    });

  const first = await ask("1.1.1.1", "9.9.9.9, 8.8.8.8");
  const second = await ask("1.1.1.1", "7.7.7.7");
  expect(first.status).toEqual(200);
  expect(second.status).toEqual(200);

  const blocked = await ask("1.1.1.1", "6.6.6.6, 5.5.5.5");
  expect(blocked.status).toEqual(429);
  expect(blocked.headers.get("retry-after")).toEqual("60");
  expect(await blocked.json()).toEqual({ status: "ERROR", reason: "too many requests" });
  expect(calls.length).toEqual(2);

  const other = await ask("2.2.2.2");
  expect(other.status).toEqual(200);

  const spoofed = await hono.request("/andes/availability", {
    headers: { "X-Forwarded-For": "1.1.1.1, 3.3.3.3" },
  });
  const sameRightmost = await hono.request("/andes/availability", {
    headers: { "X-Forwarded-For": "9.9.9.9, 3.3.3.3" },
  });
  const thirdRightmost = await hono.request("/andes/availability", {
    headers: { "X-Forwarded-For": "9.9.9.9, 3.3.3.3" },
  });
  expect(spoofed.status).toEqual(200);
  expect(sameRightmost.status).toEqual(200);
  expect(thirdRightmost.status).toEqual(429);

  nowMs += 60_000;
  const reset = await ask("1.1.1.1");
  expect(reset.status).toEqual(200);
});

Deno.test("a pubkey query that is not 64 hex is 400 and does not reveal availability", async () => {
  const { app: hono, calls } = app();
  const res = await hono.request("/andes/availability?pubkey=zz");
  expect(res.status).toEqual(400);
  expect(await res.json()).toEqual({ status: "ERROR", reason: "invalid pubkey" });
  expect(calls).toEqual([]);
});
