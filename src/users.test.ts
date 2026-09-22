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

const ALLOWED_BROWSER_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://travelsats.ar",
};

function postgresUniqueError() {
  const error = new postgres.PostgresError("duplicate key");
  (error as postgres.PostgresError & { constraint_name: string }).constraint_name =
    "users_username_unique";
  return error;
}

function mockPool() {
  const subscribed: Array<{ secret: string; userId: number }> = [];
  const unsubscribed: number[] = [];
  return {
    subscribed,
    unsubscribed,
    subscribeUser(secret: string, userId: number) {
      subscribed.push({ secret, userId });
    },
    unsubscribeUser(userId: number) {
      unsubscribed.push(userId);
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
    headers: ALLOWED_BROWSER_HEADERS,
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
    headers: ALLOWED_BROWSER_HEADERS,
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
    headers: ALLOWED_BROWSER_HEADERS,
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
    headers: ALLOWED_BROWSER_HEADERS,
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
    headers: ALLOWED_BROWSER_HEADERS,
    body: JSON.stringify(body),
  });
  expect(first.status).toEqual(200);
  const second = await app.request("/rebind", {
    method: "POST",
    headers: ALLOWED_BROWSER_HEADERS,
    body: JSON.stringify(body),
  });
  expect(second.status).toEqual(200);
  const json = await second.json();
  expect(json.status).toEqual("ERROR");
  expect(json.reason).toMatch(/already used/);
});

Deno.test("POST /users/rebind to Spark unsubscribes the leftover NWC client", async () => {
  const pool = mockPool();
  const db = {
    rebindUser: async () => ({ userId: 7, kind: "spark" as const }),
  } as unknown as DB;
  const app = createUsersApp(db, pool as unknown as NWCPool);
  const res = await app.request("/rebind", {
    method: "POST",
    headers: ALLOWED_BROWSER_HEADERS,
    body: JSON.stringify({
      username: "alice",
      nostrPubkey: NOSTR,
      rebindToken: "tok",
      sparkIdentityPubkey: SPARK_PUBKEY,
    }),
  });
  expect(res.status).toEqual(200);
  expect(pool.unsubscribed).toEqual([7]);
  expect(pool.subscribed).toHaveLength(0);
});

Deno.test("POST /users/rebind to NWC subscribes the new secret", async () => {
  const pool = mockPool();
  const db = {
    rebindUser: async () => ({
      userId: 8,
      kind: "nwc" as const,
      connectionSecret: NWC_URL,
    }),
  } as unknown as DB;
  const app = createUsersApp(db, pool as unknown as NWCPool);
  const res = await app.request("/rebind", {
    method: "POST",
    headers: ALLOWED_BROWSER_HEADERS,
    body: JSON.stringify({
      username: "alice",
      nostrPubkey: NOSTR,
      rebindToken: "tok",
      connectionSecret: NWC_URL,
    }),
  });
  expect(res.status).toEqual(200);
  expect(pool.subscribed).toEqual([{ secret: NWC_URL, userId: 8 }]);
});

const CREATE_BODY = {
  sparkIdentityPubkey: SPARK_PUBKEY,
  username: "alice",
  nostrPubkey: NOSTR,
};

const REBIND_BODY = {
  username: "alice",
  nostrPubkey: NOSTR,
  rebindToken: "tok",
  sparkIdentityPubkey: SPARK_PUBKEY,
};

function originDb() {
  const writes: string[] = [];
  const db = {
    createSparkUser: async (_sparkIdentityPubkey: string, username?: string) => {
      writes.push("createSparkUser");
      return { id: 9, username: username || "alice", nostrPubkey: NOSTR };
    },
    createUser: async (_connectionSecret: string, username?: string) => {
      writes.push("createUser");
      return { id: 3, username: username || "alice", nostrPubkey: NOSTR };
    },
    rebindUser: async () => {
      writes.push("rebindUser");
      return { userId: 7, kind: "spark" as const };
    },
  } as unknown as DB;
  return { db, writes };
}

Deno.test("POST /users and /rebind refuse a foreign Origin before any write", async () => {
  const { db, writes } = originDb();
  const app = createUsersApp(db, mockPool() as unknown as NWCPool);
  const headers = {
    "Content-Type": "application/json",
    Origin: "https://evil.example",
  };

  const create = await app.request("/", {
    method: "POST",
    headers,
    body: JSON.stringify(CREATE_BODY),
  });
  const rebind = await app.request("/rebind", {
    method: "POST",
    headers,
    body: JSON.stringify(REBIND_BODY),
  });

  expect(create.status).toEqual(403);
  expect(rebind.status).toEqual(403);
  expect(writes).toEqual([]);
});

Deno.test("POST /users allows the apex and a travelsats.ar subdomain", async () => {
  for (const origin of ["https://travelsats.ar", "https://app.travelsats.ar"]) {
    const { db, writes } = originDb();
    const app = createUsersApp(db, mockPool() as unknown as NWCPool);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(CREATE_BODY),
    });
    expect(res.status).toEqual(200);
    expect(writes).toEqual(["createSparkUser"]);
  }
});

Deno.test("POST /users/rebind allows the apex and a travelsats.ar subdomain", async () => {
  for (const origin of ["https://travelsats.ar", "https://app.travelsats.ar"]) {
    const { db, writes } = originDb();
    const app = createUsersApp(db, mockPool() as unknown as NWCPool);
    const res = await app.request("/rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(REBIND_BODY),
    });
    expect(res.status).toEqual(200);
    expect(writes).toEqual(["rebindUser"]);
  }
});

async function expectNoWrite(
  headers: Record<string, string>,
  createBody: unknown = CREATE_BODY,
  rebindBody: unknown = REBIND_BODY,
) {
  const { db, writes } = originDb();
  const app = createUsersApp(db, mockPool() as unknown as NWCPool);
  const create = await app.request("/", {
    method: "POST",
    headers,
    body: JSON.stringify(createBody),
  });
  const rebind = await app.request("/rebind", {
    method: "POST",
    headers,
    body: JSON.stringify(rebindBody),
  });
  expect(create.status).toEqual(403);
  expect(rebind.status).toEqual(403);
  expect(writes).toEqual([]);
}

Deno.test("lookalike hosts are not a travelsats.ar origin", async () => {
  for (const origin of ["https://evil-travelsats.ar", "https://travelsats.ar.evil.example"]) {
    await expectNoWrite({
      "Content-Type": "application/json",
      Origin: origin,
    });
  }
});

const NWC_CREATE_BODY = {
  connectionSecret: NWC_URL,
  username: "bob",
  nostrPubkey: NOSTR,
};

const NWC_REBIND_BODY = {
  username: "alice",
  nostrPubkey: NOSTR,
  rebindToken: "tok",
  connectionSecret: NWC_URL,
};

Deno.test("POST /users and /rebind refuse a foreign Origin for an NWC body before any write", async () => {
  await expectNoWrite(
    {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    NWC_CREATE_BODY,
    NWC_REBIND_BODY,
  );
});

const REGISTRATION_SECRET = "travelsats-registration-test-secret";

function proxyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Travelsats-Registration": REGISTRATION_SECRET,
    ...extra,
  };
}

Deno.test("missing Origin without the registration credential does not write", async () => {
  const previous = Deno.env.get("TRAVELSATS_REGISTRATION_SECRET");
  Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", REGISTRATION_SECRET);
  try {
    const headerSets: Record<string, string>[] = [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", Origin: "" },
      { "Content-Type": "application/json", Origin: "   " },
      proxyHeaders({ "X-Travelsats-Registration": "wrong-secret" }),
    ];
    for (const headers of headerSets) {
      await expectNoWrite(headers);
      await expectNoWrite(headers, NWC_CREATE_BODY, NWC_REBIND_BODY);
    }
    Deno.env.delete("TRAVELSATS_REGISTRATION_SECRET");
    await expectNoWrite(proxyHeaders());
  } finally {
    if (previous == null) Deno.env.delete("TRAVELSATS_REGISTRATION_SECRET");
    else Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", previous);
  }
});

Deno.test("registration credential creates and rebinds Spark and NWC users without Origin", async () => {
  const previous = Deno.env.get("TRAVELSATS_REGISTRATION_SECRET");
  Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", REGISTRATION_SECRET);
  try {
    const spark = originDb();
    const sparkRes = await createUsersApp(spark.db, mockPool() as unknown as NWCPool).request(
      "/",
      { method: "POST", headers: proxyHeaders(), body: JSON.stringify(CREATE_BODY) },
    );
    expect(sparkRes.status).toEqual(200);
    expect(spark.writes).toEqual(["createSparkUser"]);

    const nwc = originDb();
    const pool = mockPool();
    const nwcRes = await createUsersApp(nwc.db, pool as unknown as NWCPool).request("/", {
      method: "POST",
      headers: proxyHeaders(),
      body: JSON.stringify(NWC_CREATE_BODY),
    });
    expect(nwcRes.status).toEqual(200);
    expect(nwc.writes).toEqual(["createUser"]);
    expect(pool.subscribed).toEqual([{ secret: NWC_URL, userId: 3 }]);

    const rebound = originDb();
    const rebindRes = await createUsersApp(rebound.db, mockPool() as unknown as NWCPool).request(
      "/rebind",
      { method: "POST", headers: proxyHeaders(), body: JSON.stringify(REBIND_BODY) },
    );
    expect(rebindRes.status).toEqual(200);
    expect(rebound.writes).toEqual(["rebindUser"]);

    await expectNoWrite(proxyHeaders({ Origin: "https://evil.example" }));
  } finally {
    if (previous == null) Deno.env.delete("TRAVELSATS_REGISTRATION_SECRET");
    else Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", previous);
  }
});
