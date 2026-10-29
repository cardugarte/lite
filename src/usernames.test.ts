import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "./db/db.ts";
import { createUsernamesApp } from "./usernames.ts";

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

Deno.test("a pubkey query that is not 64 hex is 400 and does not reveal availability", async () => {
  const { app: hono, calls } = app();
  const res = await hono.request("/andes/availability?pubkey=zz");
  expect(res.status).toEqual(400);
  expect(await res.json()).toEqual({ status: "ERROR", reason: "invalid pubkey" });
  expect(calls).toEqual([]);
});
