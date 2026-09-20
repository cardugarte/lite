import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import postgres from "postgres";
import type { DB } from "./db/db.ts";
import type { NWCPool } from "./nwc/nwcPool.ts";
import { createUsersApp } from "./users.ts";

const NOSTR = "aa".repeat(32);
const SPARK_PUBKEY =
  "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NWC_URL =
  "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";

function postgresUniqueError() {
  const error = new postgres.PostgresError("duplicate key");
  (error as postgres.PostgresError & { constraint_name: string }).constraint_name =
    "users_username_unique";
  return error;
}

function mockPool() {
  const subscribed: Array<{ secret: string; userId: number }> = [];
  return {
    subscribed,
    subscribeUser(secret: string, userId: number) {
      subscribed.push({ secret, userId });
    },
  };
}

Deno.test("POST /users spark path does not store or subscribe an NWC secret", async () => {
  const created: unknown[] = [];
  const pool = mockPool();
  const db = {
    createSparkUser: async (
      sparkIdentityPubkey: string,
      username?: string,
      nostrPubkey?: string,
    ) => {
      created.push({ sparkIdentityPubkey, username, nostrPubkey });
      return { id: 9, username: username || "sparkuser", nostrPubkey };
    },
    createUser: async () => {
      throw new Error("NWC createUser must not run for spark");
    },
  } as unknown as DB;

  const app = createUsersApp(db, pool as unknown as NWCPool);
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sparkIdentityPubkey: SPARK_PUBKEY,
      username: "alice",
      nostrPubkey: NOSTR,
    }),
  });
  expect(res.status).toEqual(200);
  expect(await res.json()).toEqual({ lightningAddress: "alice@lnaddr.test" });
  expect(created).toEqual([
    { sparkIdentityPubkey: SPARK_PUBKEY, username: "alice", nostrPubkey: NOSTR },
  ]);
  expect(pool.subscribed).toHaveLength(0);
});

Deno.test("POST /users NWC path still creates from a connection secret", async () => {
  const created: unknown[] = [];
  const pool = mockPool();
  const db = {
    createUser: async (
      connectionSecret: string,
      username?: string,
      nostrPubkey?: string,
    ) => {
      created.push({ connectionSecret, username, nostrPubkey });
      return { id: 3, username: username || "nwcuser", nostrPubkey };
    },
    createSparkUser: async () => {
      throw new Error("spark path must not run for NWC");
    },
  } as unknown as DB;

  const app = createUsersApp(db, pool as unknown as NWCPool);
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionSecret: NWC_URL,
      username: "bob",
      nostrPubkey: NOSTR,
    }),
  });
  expect(res.status).toEqual(200);
  expect(await res.json()).toEqual({ lightningAddress: "bob@lnaddr.test" });
  expect(created).toEqual([
    { connectionSecret: NWC_URL, username: "bob", nostrPubkey: NOSTR },
  ]);
  expect(pool.subscribed).toEqual([{ secret: NWC_URL, userId: 3 }]);
});

Deno.test("POST /users still rejects duplicate username", async () => {
  const db = {
    createSparkUser: async () => {
      throw postgresUniqueError();
    },
    createUser: async () => {
      throw postgresUniqueError();
    },
  } as unknown as DB;
  const app = createUsersApp(db, mockPool() as unknown as NWCPool);

  const sparkRes = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sparkIdentityPubkey: SPARK_PUBKEY,
      username: "taken",
      nostrPubkey: NOSTR,
    }),
  });
  expect(sparkRes.status).toEqual(200);
  expect(await sparkRes.json()).toEqual({
    status: "ERROR",
    reason: "Username has already been taken",
  });

  const nwcRes = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionSecret: NWC_URL,
      username: "taken",
      nostrPubkey: NOSTR,
    }),
  });
  expect(nwcRes.status).toEqual(200);
  expect(await nwcRes.json()).toEqual({
    status: "ERROR",
    reason: "Username has already been taken",
  });
});

Deno.test("POST /users/rebind rejects replay of a used token", async () => {
  const used = new Set<string>();
  const db = {
    rebindUser: async (input: { rebindToken: string }) => {
      if (used.has(input.rebindToken)) {
        throw new Error("rebind token already used");
      }
      used.add(input.rebindToken);
    },
  } as unknown as DB;
  const app = createUsersApp(db, mockPool() as unknown as NWCPool);
  const body = {
    username: "alice",
    nostrPubkey: NOSTR,
    rebindToken: "once-only",
    sparkIdentityPubkey: SPARK_PUBKEY,
  };
  const first = await app.request("/rebind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(first.status).toEqual(200);
  const second = await app.request("/rebind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(second.status).toEqual(200);
  const json = await second.json();
  expect(json.status).toEqual("ERROR");
  expect(json.reason).toMatch(/already used/);
});
