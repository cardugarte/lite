import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import { decrypt } from "./db/aesgcm.ts";
import type { DB } from "./db/db.ts";
import { logger } from "./logger.ts";
import type { NWCPool } from "./nwc/nwcPool.ts";
import { createUsersApp } from "./users.ts";

const NOSTR = "aa".repeat(32);
const OTHER_NOSTR = "bb".repeat(32);
const SPARK_PUBKEY =
  "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NWC_URL =
  "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";
const SECRET = "s3cret";

const ALLOWED_BROWSER_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://travelsats.ar",
};

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

type StoredUser = {
  id: number;
  username: string;
  nostrPubkey: string;
  connectionSecret: string;
};

function userDb(mode: "ok" | "unique" | "boom" | "race" = "ok") {
  const rows: StoredUser[] = [];
  let chain: Promise<void> = Promise.resolve();
  const db = {
    createUser: (input: {
      npubHex: string;
      username: string;
      encryptedSecret: string;
      now: Date;
    }) => {
      const run = chain.then(async () => {
        if (mode === "boom") throw new Error("connection refused");
        if (mode === "unique" || rows.some((row) => row.username === input.username)) {
          return { kind: "conflict" as const, reason: "username_taken" as const };
        }
        const row = {
          id: rows.length + 1,
          username: input.username,
          nostrPubkey: input.npubHex,
          connectionSecret: await decrypt(input.encryptedSecret),
        };
        rows.push(row);
        if (mode === "race") await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          kind: "created" as const,
          user: {
            id: row.id,
            username: row.username,
            nostrPubkey: row.nostrPubkey,
            destination: "nwc" as const,
            sparkIdentityPubkey: null,
            encryptedConnectionSecret: input.encryptedSecret,
          },
        };
      });
      chain = run.then(() => {}, () => {});
      return run;
    },
  } as unknown as DB;
  return { db, rows };
}

async function withSecret<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("TRAVELSATS_REGISTRATION_SECRET");
  if (value === undefined) Deno.env.delete("TRAVELSATS_REGISTRATION_SECRET");
  else Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", value);
  try {
    return await fn();
  } finally {
    if (previous == null) Deno.env.delete("TRAVELSATS_REGISTRATION_SECRET");
    else Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", previous);
  }
}

function secretHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Travelsats-Registration": SECRET,
    ...extra,
  };
}

function nwcBody(username = "alice", nostrPubkey = NOSTR, connectionSecret = NWC_URL) {
  return { connectionSecret, username, nostrPubkey };
}

async function postUsers(
  db: DB,
  headers: Record<string, string>,
  body: unknown,
  pool = mockPool(),
) {
  const app = createUsersApp(db, pool as unknown as NWCPool);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const res = await app.request("/", {
    method: "POST",
    headers,
    body: payload,
  });
  return { res, pool };
}

Deno.test("POST /users rejects sparkIdentityPubkey and creates no row", async () => {
  await withSecret(SECRET, async () => {
    const calls: string[] = [];
    const db = {
      createUser: async () => {
        calls.push("createUser");
        return { id: 1, username: "alice", nostrPubkey: NOSTR };
      },
      createSparkUser: async () => {
        calls.push("createSparkUser");
        return { id: 9, username: "alice", nostrPubkey: NOSTR };
      },
    } as unknown as DB;
    const sparkOnly = await postUsers(db, secretHeaders(), {
      sparkIdentityPubkey: SPARK_PUBKEY,
      username: "alice",
      nostrPubkey: NOSTR,
    });
    const both = await postUsers(db, secretHeaders(), {
      sparkIdentityPubkey: SPARK_PUBKEY,
      connectionSecret: NWC_URL,
      username: "alice",
      nostrPubkey: NOSTR,
    });
    for (const res of [sparkOnly.res, both.res]) {
      expect(res.status).toEqual(400);
      expect(await res.json()).toEqual({
        status: "ERROR",
        reason:
          "sparkIdentityPubkey is not accepted; register Spark addresses through the signed LNURL register",
      });
    }
    expect(calls).toEqual([]);
  });
});

Deno.test("POST /users/rebind with a valid secret is 404", async () => {
  await withSecret(SECRET, async () => {
    const db = {} as unknown as DB;
    const app = createUsersApp(db, mockPool() as unknown as NWCPool);
    const res = await app.request("/rebind", {
      method: "POST",
      headers: secretHeaders(),
      body: JSON.stringify({
        username: "alice",
        nostrPubkey: NOSTR,
        rebindToken: "tok",
        sparkIdentityPubkey: SPARK_PUBKEY,
      }),
    });
    expect(res.status).toEqual(404);
  });
});

Deno.test("Origin alone does not authorize POST /users", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const { res } = await postUsers(
      db,
      { "Content-Type": "application/json", Origin: "https://travelsats.ar" },
      nwcBody(),
    );
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
    expect(rows).toEqual([]);
  });
});

Deno.test("subdomain Origin alone does not authorize POST /users", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const { res } = await postUsers(
      db,
      { "Content-Type": "application/json", Origin: "https://dev.travelsats.ar" },
      nwcBody(),
    );
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
    expect(rows).toEqual([]);
  });
});

Deno.test("valid secret without Origin creates the user", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const pool = mockPool();
    const { res } = await postUsers(db, secretHeaders(), nwcBody(), pool);
    expect(res.status).toEqual(200);
    expect(await res.text()).toEqual(
      JSON.stringify({ lightningAddress: "alice@lnaddr.test" }),
    );
    expect(rows).toEqual([{
      id: 1,
      username: "alice",
      nostrPubkey: NOSTR,
      connectionSecret: NWC_URL,
    }]);
    expect(pool.subscribed).toEqual([{ secret: NWC_URL, userId: 1 }]);
  });
});

Deno.test("hostile Origin with a valid secret is ignored", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const { res } = await postUsers(
      db,
      secretHeaders({ Origin: "https://evil.example" }),
      nwcBody(),
    );
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ lightningAddress: "alice@lnaddr.test" });
    expect(rows).toHaveLength(1);
  });
});

Deno.test("wrong secret of equal length and different length is forbidden", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    for (const presented of ["s3creX", "s3cret-and-more"]) {
      const { res } = await postUsers(
        db,
        secretHeaders({ "X-Travelsats-Registration": presented }),
        nwcBody(),
      );
      expect(res.status).toEqual(403);
      expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
    }
    expect(rows).toEqual([]);
  });
});

Deno.test("unset, empty, and whitespace-only secret is 503 for every header", async () => {
  const headerSets = [
    { "Content-Type": "application/json" },
    secretHeaders({ "X-Travelsats-Registration": "" }),
    secretHeaders({ "X-Travelsats-Registration": "nope" }),
  ];
  for (const secret of [undefined, "", "   "]) {
    await withSecret(secret, async () => {
      for (const headers of headerSets) {
        const { db, rows } = userDb();
        const { res } = await postUsers(db, headers, nwcBody());
        expect(res.status).toEqual(503);
        expect(await res.json()).toEqual({
          status: "ERROR",
          reason: "registration credential not configured",
        });
        expect(rows).toEqual([]);
      }
    });
  }
});

Deno.test("authentication precedes body parsing", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const { res } = await postUsers(
      db,
      { "Content-Type": "application/json" },
      "{",
    );
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
    expect(rows).toEqual([]);
  });
});

Deno.test("Origin variants without the secret are forbidden", async () => {
  await withSecret(SECRET, async () => {
    const origins: Array<Record<string, string>> = [
      {},
      { Origin: "https://travelsats.ar" },
      { Origin: "http://travelsats.ar" },
      { Origin: "https://x.travelsats.ar" },
      { Origin: "null" },
    ];
    for (const extra of origins) {
      const { db, rows } = userDb();
      const { res } = await postUsers(
        db,
        { "Content-Type": "application/json", ...extra },
        nwcBody(),
      );
      expect(res.status).toEqual(403);
      expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
      expect(rows).toEqual([]);
    }
  });
});

Deno.test("Bearer token alone is forbidden", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const { res } = await postUsers(
      db,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      nwcBody(),
    );
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
    expect(rows).toEqual([]);
  });
});

Deno.test("Authorization is ignored when the secret is valid", async () => {
  await withSecret(SECRET, async () => {
    const { db } = userDb();
    const withBearer = await postUsers(
      db,
      secretHeaders({ Authorization: "Bearer junk" }),
      nwcBody("alice"),
    );
    const without = await postUsers(db, secretHeaders(), nwcBody("bob"));
    expect(withBearer.res.status).toEqual(200);
    expect(without.res.status).toEqual(200);
    expect(await withBearer.res.json()).toEqual({
      lightningAddress: "alice@lnaddr.test",
    });
    expect(await without.res.json()).toEqual({ lightningAddress: "bob@lnaddr.test" });
  });
});

Deno.test("duplicate username is 409 and leaves the existing row unchanged", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const first = await postUsers(db, secretHeaders(), nwcBody("alice", NOSTR));
    expect(first.res.status).toEqual(200);
    const second = await postUsers(db, secretHeaders(), nwcBody("alice", OTHER_NOSTR));
    expect(second.res.status).toEqual(409);
    expect(await second.res.json()).toEqual({
      status: "ERROR",
      reason: "Username has already been taken",
    });
    expect(rows).toEqual([{
      id: 1,
      username: "alice",
      nostrPubkey: NOSTR,
      connectionSecret: NWC_URL,
    }]);
  });
});

Deno.test("concurrent duplicate creates give one 200 and one 409", async () => {
  await withSecret(SECRET, async () => {
    const { db } = userDb("race");
    const [left, right] = await Promise.all([
      postUsers(db, secretHeaders(), nwcBody("alice")),
      postUsers(db, secretHeaders(), nwcBody("alice")),
    ]);
    const statuses = [left.res.status, right.res.status].sort();
    expect(statuses).toEqual([200, 409]);
    for (const res of [left.res, right.res]) {
      if (res.status === 409) {
        expect(await res.json()).toEqual({
          status: "ERROR",
          reason: "Username has already been taken",
        });
      }
    }
  });
});

Deno.test("invalid NWC secret is 400 and creates no row", async () => {
  await withSecret(SECRET, async () => {
    const { db, rows } = userDb();
    const { res } = await postUsers(
      db,
      secretHeaders(),
      nwcBody("alice", NOSTR, "not-a-url"),
    );
    expect(res.status).toEqual(400);
    const body = await res.json();
    expect(body.status).toEqual("ERROR");
    expect(typeof body.reason).toEqual("string");
    expect(body.reason.length).toBeGreaterThan(0);
    expect(rows).toEqual([]);
  });
});

Deno.test("invalid JSON is 400 invalid json", async () => {
  await withSecret(SECRET, async () => {
    const { res } = await postUsers(userDb().db, secretHeaders(), "{");
    expect(res.status).toEqual(400);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "invalid json" });
  });
});

Deno.test("missing and invalid nostrPubkey are 400", async () => {
  await withSecret(SECRET, async () => {
    const missing = await postUsers(userDb().db, secretHeaders(), {
      connectionSecret: NWC_URL,
      username: "alice",
    });
    expect(missing.res.status).toEqual(400);
    expect(await missing.res.json()).toEqual({
      status: "ERROR",
      reason: "no nostr pubkey provided",
    });
    const invalid = await postUsers(userDb().db, secretHeaders(), nwcBody("alice", "zz"));
    expect(invalid.res.status).toEqual(400);
    expect(await invalid.res.json()).toEqual({
      status: "ERROR",
      reason: "invalid nostr pubkey provided",
    });
  });
});

Deno.test("unexpected database failure is an opaque 500", async () => {
  await withSecret(SECRET, async () => {
    const { res } = await postUsers(userDb("boom").db, secretHeaders(), nwcBody());
    expect(res.status).toEqual(500);
    const text = await res.text();
    expect(text).toEqual(JSON.stringify({ status: "ERROR", reason: "internal error" }));
    expect(text).not.toContain("connection refused");
  });
});

Deno.test("failing POST /users inputs never return 2xx with status ERROR", async () => {
  await withSecret(SECRET, async () => {
    const cases: Array<{ name: string; headers: Record<string, string>; body: unknown; mode?: "boom" }> = [
      {
        name: "wrong secret",
        headers: secretHeaders({ "X-Travelsats-Registration": "s3creX" }),
        body: nwcBody(),
      },
      { name: "invalid json", headers: secretHeaders(), body: "{" },
      {
        name: "missing pubkey",
        headers: secretHeaders(),
        body: { connectionSecret: NWC_URL, username: "alice" },
      },
      { name: "invalid pubkey", headers: secretHeaders(), body: nwcBody("alice", "nope") },
      {
        name: "invalid nwc",
        headers: secretHeaders(),
        body: nwcBody("alice", NOSTR, "not-a-url"),
      },
      { name: "database", headers: secretHeaders(), body: nwcBody(), mode: "boom" },
      { name: "origin only", headers: ALLOWED_BROWSER_HEADERS, body: nwcBody() },
    ];
    const offenders: string[] = [];
    for (const item of cases) {
      const { res } = await postUsers(userDb(item.mode ?? "ok").db, item.headers, item.body);
      const text = await res.text();
      let statusField: string | undefined;
      try {
        statusField = JSON.parse(text).status;
      } catch {
        statusField = undefined;
      }
      if (res.status >= 200 && res.status < 300 && statusField === "ERROR") {
        offenders.push(`${item.name}:${res.status}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

Deno.test("registration and authorization header values are not logged", async () => {
  await withSecret(SECRET, async () => {
    const writable = logger as unknown as {
      levelName: string;
      handlers: Array<{ levelName: string }>;
    };
    const previousLevel = writable.levelName;
    const previousHandlers = writable.handlers.map((handler) => handler.levelName);
    writable.levelName = "DEBUG";
    for (const handler of writable.handlers) handler.levelName = "DEBUG";
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
    };
    try {
      const { res } = await postUsers(
        userDb().db,
        secretHeaders({ Authorization: "Bearer TOKEN-123" }),
        nwcBody(),
      );
      expect(res.status).toEqual(200);
      await res.json();
    } finally {
      console.log = original;
      writable.levelName = previousLevel;
      writable.handlers.forEach((handler, index) => {
        handler.levelName = previousHandlers[index];
      });
    }
    expect(lines.length).toBeGreaterThan(0);
    const captured = lines.join("\n");
    expect(captured).not.toContain("TOKEN-123");
    expect(captured).not.toContain(SECRET);
  });
});


