import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import { LNURL_DOMAIN } from "./constants.ts";
import { decrypt } from "./db/aesgcm.ts";
import type { DB } from "./db/db.ts";
import { logger } from "./logger.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
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



// ---------------------------------------------------------------------------
// L7: create conflicts, binding intents, NWC bind, abandon, one LNURL domain.
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-03-01T12:00:00.000Z");
const NPUB_HEADER = "X-Travelsats-Nostr-Pubkey";

function assertedHeaders(npub = NOSTR, extra: Record<string, string> = {}) {
  return secretHeaders({ [NPUB_HEADER]: npub, ...extra });
}

async function callUsers(
  db: DB,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  pool = mockPool(),
) {
  const app = createUsersApp(db, pool as unknown as NWCPool, () => FIXED_NOW);
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const res = await app.request(path, { method, headers, body: payload });
  return { res, pool };
}

function createdUser(id: number, username: string) {
  return {
    id,
    username,
    nostrPubkey: NOSTR,
    destination: "nwc" as const,
    sparkIdentityPubkey: null,
    encryptedConnectionSecret: "enc",
  };
}

// L7.1: POST /users conflicts ------------------------------------------------

Deno.test("POST /users maps every repository conflict to its status and text", async () => {
  await withSecret(SECRET, async () => {
    const cases = [
      { reason: "username_taken", text: "Username has already been taken" },
      { reason: "account_exists", text: "Account already has a Lightning Address" },
      { reason: "name_in_progress", text: "name is being registered" },
    ];
    for (const item of cases) {
      const db = {
        createUser: async () => ({ kind: "conflict", reason: item.reason }),
      } as unknown as DB;
      const { res, pool } = await callUsers(db, "POST", "/", secretHeaders(), nwcBody());
      expect(res.status).toEqual(409);
      expect(await res.json()).toEqual({ status: "ERROR", reason: item.text });
      expect(pool.subscribed).toEqual([]);
    }
  });
});

Deno.test("POST /users answers the first conflict in table order when several apply", async () => {
  await withSecret(SECRET, async () => {
    const state = { usernameTaken: true, accountExists: true, foreignIntent: true };
    const db = {
      createUser: async () => {
        if (state.usernameTaken) return { kind: "conflict", reason: "username_taken" };
        if (state.accountExists) return { kind: "conflict", reason: "account_exists" };
        if (state.foreignIntent) return { kind: "conflict", reason: "name_in_progress" };
        return { kind: "created", user: createdUser(1, "alice") };
      },
    } as unknown as DB;
    const reasons: string[] = [];
    for (const step of ["usernameTaken", "accountExists", "foreignIntent"] as const) {
      const { res } = await callUsers(db, "POST", "/", secretHeaders(), nwcBody());
      reasons.push((await res.json()).reason);
      state[step] = false;
    }
    expect(reasons).toEqual([
      "Username has already been taken",
      "Account already has a Lightning Address",
      "name is being registered",
    ]);
    const { res } = await callUsers(db, "POST", "/", secretHeaders(), nwcBody());
    expect(res.status).toEqual(200);
  });
});

Deno.test("POST /users hands the repository a lowercase account, a lowercase name, and the clock", async () => {
  await withSecret(SECRET, async () => {
    const seen: Array<Record<string, unknown>> = [];
    const db = {
      createUser: async (input: Record<string, unknown>) => {
        seen.push(input);
        return { kind: "created", user: createdUser(4, "alice") };
      },
    } as unknown as DB;
    const { res, pool } = await callUsers(
      db,
      "POST",
      "/",
      secretHeaders(),
      nwcBody("Alice", NOSTR.toUpperCase()),
    );
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ lightningAddress: `alice@${LNURL_DOMAIN}` });
    expect(seen.length).toEqual(1);
    expect(seen[0].npubHex).toEqual(NOSTR);
    expect(seen[0].username).toEqual("alice");
    expect(seen[0].now).toEqual(FIXED_NOW);
    expect(await decrypt(seen[0].encryptedSecret as string)).toEqual(NWC_URL);
    expect(pool.subscribed).toEqual([{ secret: NWC_URL, userId: 4 }]);
  });
});

// L7.2: POST /users/binding-intents -----------------------------------------

function intentRepo(result: unknown = { kind: "ok", expiresAt: new Date("2026-03-01T12:10:00.000Z") }) {
  const calls: Array<Record<string, unknown>> = [];
  const db = {
    createBindingIntent: async (input: Record<string, unknown>) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as DB;
  return { db, calls };
}

const intentBody = (overrides: Record<string, unknown> = {}) => ({
  username: "alice",
  sparkPubkey: SPARK_PUBKEY,
  ...overrides,
});

Deno.test("POST /users/binding-intents needs the secret before anything else", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = intentRepo();
    const noSecret = await callUsers(db, "POST", "/binding-intents", { "Content-Type": "application/json" }, "not json");
    expect(noSecret.res.status).toEqual(403);
    const wrong = await callUsers(
      db,
      "POST",
      "/binding-intents",
      { "X-Travelsats-Registration": "nope", [NPUB_HEADER]: NOSTR },
      intentBody(),
    );
    expect(wrong.res.status).toEqual(403);
    expect(calls).toEqual([]);
  });
  await withSecret(undefined, async () => {
    const { db, calls } = intentRepo();
    const { res } = await callUsers(db, "POST", "/binding-intents", assertedHeaders(), intentBody());
    expect(res.status).toEqual(503);
    expect(calls).toEqual([]);
  });
});

Deno.test("POST /users/binding-intents rejects a missing or malformed npub assertion", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = intentRepo();
    for (const headers of [secretHeaders(), assertedHeaders("aa".repeat(31) + "a"), assertedHeaders("zz".repeat(32))]) {
      const { res } = await callUsers(db, "POST", "/binding-intents", headers, intentBody());
      expect(res.status).toEqual(400);
      expect(await res.json()).toEqual({ status: "ERROR", reason: "missing or invalid npub assertion" });
    }
    expect(calls).toEqual([]);
  });
});

Deno.test("POST /users/binding-intents validates the body and creates nothing on rejection", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = intentRepo();
    const cases: Array<{ body: unknown; status: number; reason: string }> = [
      { body: "not json", status: 400, reason: "invalid json" },
      { body: "[]", status: 400, reason: "invalid request" },
      { body: "null", status: 400, reason: "invalid request" },
      { body: intentBody({ sparkPubkey: SPARK_PUBKEY.toUpperCase().replace(/^0/, "0") }), status: 400, reason: "invalid sparkPubkey" },
      { body: intentBody({ sparkPubkey: "04" + "ab".repeat(32) }), status: 400, reason: "invalid sparkPubkey" },
      { body: intentBody({ sparkPubkey: 42 }), status: 400, reason: "invalid sparkPubkey" },
      { body: intentBody({ username: "has space" }), status: 400, reason: "invalid username" },
      { body: intentBody({ username: "a..b" }), status: 400, reason: "invalid username" },
      { body: intentBody({ username: "   " }), status: 400, reason: "invalid username" },
      { body: intentBody({ username: 7 }), status: 400, reason: "invalid username" },
      { body: intentBody({ username: "a".repeat(65) }), status: 400, reason: "username too long" },
    ];
    for (const item of cases) {
      const { res } = await callUsers(db, "POST", "/binding-intents", assertedHeaders(), item.body);
      expect(res.status).toEqual(item.status);
      expect(await res.json()).toEqual({ status: "ERROR", reason: item.reason });
    }
    expect(calls).toEqual([]);
  });
});

Deno.test("POST /users/binding-intents lowercases the account and name and answers expiresAt", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = intentRepo();
    const { res } = await callUsers(
      db,
      "POST",
      "/binding-intents",
      assertedHeaders(NOSTR.toUpperCase()),
      intentBody({ username: "  Alice ", nostrPubkey: OTHER_NOSTR }),
    );
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ expiresAt: "2026-03-01T12:10:00.000Z" });
    expect(calls).toEqual([{ npubHex: NOSTR, username: "alice", sparkPubkey: SPARK_PUBKEY, now: FIXED_NOW }]);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

Deno.test("POST /users/binding-intents maps each conflict row to its exact reason", async () => {
  await withSecret(SECRET, async () => {
    const cases = [
      ["name_taken", "name already taken"],
      ["account_username_differs", "account holds a different username"],
      ["pubkey_taken", "pubkey already holds an address"],
      ["name_in_progress", "name is being registered"],
    ];
    for (const [reason, text] of cases) {
      const { db } = intentRepo({ kind: "conflict", reason });
      const { res } = await callUsers(db, "POST", "/binding-intents", assertedHeaders(), intentBody());
      expect(res.status).toEqual(409);
      expect(await res.json()).toEqual({ status: "ERROR", reason: text });
    }
  });
});

Deno.test("POST /users/binding-intents answers an opaque 500 on a repository failure", async () => {
  await withSecret(SECRET, async () => {
    const { db } = intentRepo(new Error("connection refused: postgres://u:p@host"));
    const { res } = await callUsers(db, "POST", "/binding-intents", assertedHeaders(), intentBody());
    expect(res.status).toEqual(500);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "internal error" });
  });
});

Deno.test("GET /users/binding-intents exposes nothing", async () => {
  await withSecret(SECRET, async () => {
    const { db } = intentRepo();
    const { res } = await callUsers(db, "GET", "/binding-intents", assertedHeaders());
    expect(res.status).toEqual(404);
    const text = await res.text();
    expect(text.includes("expiresAt")).toEqual(false);
    expect(text.includes(SPARK_PUBKEY)).toEqual(false);
  });
});

// L7.3: POST /users/nwc-bind -------------------------------------------------

function bindRepo(result: unknown) {
  const calls: Array<{ npubHex: string; encryptedSecret: string; now: Date }> = [];
  const db = {
    bindNwcDestination: async (npubHex: string, encryptedSecret: string, now: Date) => {
      calls.push({ npubHex, encryptedSecret, now });
      return result;
    },
  } as unknown as DB;
  return { db, calls };
}

const boundResult = (id: number, username = "alice") => ({
  kind: "bound",
  user: { ...createdUser(id, username), destination: "nwc" },
});

Deno.test("POST /users/nwc-bind moves the account to NWC with an encrypted secret and subscribes the row", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = bindRepo(boundResult(7));
    const { res, pool } = await callUsers(
      db,
      "POST",
      "/nwc-bind",
      assertedHeaders(NOSTR.toUpperCase()),
      { connectionSecret: NWC_URL },
    );
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ lightningAddress: `alice@${LNURL_DOMAIN}` });
    expect(calls.length).toEqual(1);
    expect(calls[0].npubHex).toEqual(NOSTR);
    expect(calls[0].now).toEqual(FIXED_NOW);
    expect(calls[0].encryptedSecret).not.toEqual(NWC_URL);
    expect(await decrypt(calls[0].encryptedSecret)).toEqual(NWC_URL);
    expect(pool.subscribed).toEqual([{ secret: NWC_URL, userId: 7 }]);
  });
});

Deno.test("POST /users/nwc-bind replaces the subscription of an NWC row with one for the new secret", async () => {
  await withSecret(SECRET, async () => {
    const created: string[] = [];
    let closed = 0;
    const pool = new NWCPool({} as unknown as DB, decrypt, (secret) => {
      created.push(secret);
      return { subscribeNotifications() {}, close: () => { closed += 1; } };
    });
    const OLD_URL = NWC_URL.replace("bdaec861", "cafebabe");
    pool.subscribeUser(OLD_URL, 7);
    const { db } = bindRepo(boundResult(7));
    const app = createUsersApp(db, pool, () => FIXED_NOW);
    const res = await app.request("/nwc-bind", {
      method: "POST",
      headers: assertedHeaders(),
      body: JSON.stringify({ connectionSecret: NWC_URL }),
    });
    expect(res.status).toEqual(200);
    expect(created).toEqual([OLD_URL, NWC_URL]);
    expect(closed).toEqual(1);
  });
});

Deno.test("POST /users/nwc-bind answers 404 for an unknown account and 409 for a name in progress", async () => {
  await withSecret(SECRET, async () => {
    const missing = bindRepo({ kind: "not_found" });
    const notFound = await callUsers(missing.db, "POST", "/nwc-bind", assertedHeaders(), { connectionSecret: NWC_URL });
    expect(notFound.res.status).toEqual(404);
    expect(await notFound.res.json()).toEqual({ status: "ERROR", reason: "user not found" });
    expect(notFound.pool.subscribed).toEqual([]);

    const busy = bindRepo({ kind: "conflict", reason: "name_in_progress" });
    const conflict = await callUsers(busy.db, "POST", "/nwc-bind", assertedHeaders(), { connectionSecret: NWC_URL });
    expect(conflict.res.status).toEqual(409);
    expect(await conflict.res.json()).toEqual({ status: "ERROR", reason: "name is being registered" });
    expect(conflict.pool.subscribed).toEqual([]);
  });
});

Deno.test("POST /users/nwc-bind validates the secret before touching the row", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = bindRepo(boundResult(7));
    const noSecretUri = "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1";
    const invalid = await callUsers(db, "POST", "/nwc-bind", assertedHeaders(), { connectionSecret: noSecretUri });
    expect(invalid.res.status).toEqual(400);
    expect((await invalid.res.json()).status).toEqual("ERROR");
    const missing = await callUsers(db, "POST", "/nwc-bind", assertedHeaders(), {});
    expect(missing.res.status).toEqual(400);
    expect(await missing.res.json()).toEqual({ status: "ERROR", reason: "no connection secret provided" });
    const notJson = await callUsers(db, "POST", "/nwc-bind", assertedHeaders(), "not json");
    expect(notJson.res.status).toEqual(400);
    expect(await notJson.res.json()).toEqual({ status: "ERROR", reason: "invalid json" });
    expect(calls).toEqual([]);
  });
});

Deno.test("POST /users/nwc-bind checks the secret, then the npub header, and ignores other body keys", async () => {
  await withSecret(SECRET, async () => {
    const { db, calls } = bindRepo(boundResult(7));
    const noSecret = await callUsers(db, "POST", "/nwc-bind", { "Content-Type": "application/json", [NPUB_HEADER]: NOSTR }, { connectionSecret: NWC_URL });
    expect(noSecret.res.status).toEqual(403);
    const noNpub = await callUsers(db, "POST", "/nwc-bind", secretHeaders(), { connectionSecret: NWC_URL });
    expect(noNpub.res.status).toEqual(400);
    expect(await noNpub.res.json()).toEqual({ status: "ERROR", reason: "missing or invalid npub assertion" });
    expect(calls).toEqual([]);

    const { res } = await callUsers(db, "POST", "/nwc-bind", assertedHeaders(), {
      connectionSecret: NWC_URL,
      nostrPubkey: OTHER_NOSTR,
      username: "mallory",
      destination: "spark",
    });
    expect(res.status).toEqual(200);
    expect(calls.map((call) => call.npubHex)).toEqual([NOSTR]);
  });
  await withSecret(undefined, async () => {
    const { db } = bindRepo(boundResult(7));
    const { res } = await callUsers(db, "POST", "/nwc-bind", assertedHeaders(), { connectionSecret: NWC_URL });
    expect(res.status).toEqual(503);
  });
});

// L7.4: DELETE /users --------------------------------------------------------

function abandonRepo(existing: { id: number } | null, removed: number) {
  const events: string[] = [];
  const db = {
    findUserByNostrPubkey: async (npub: string) => {
      events.push(`find:${npub}`);
      return existing;
    },
    deleteUserByNostrPubkey: async (npub: string) => {
      events.push(`delete:${npub}`);
      return removed;
    },
  } as unknown as DB;
  return { db, events };
}

Deno.test("DELETE /users removes only the asserted account and cancels its subscription after the delete", async () => {
  await withSecret(SECRET, async () => {
    const { db, events } = abandonRepo({ id: 5 }, 1);
    const pool = mockPool();
    const original = pool.unsubscribeUser.bind(pool);
    pool.unsubscribeUser = (userId: number) => {
      events.push(`unsubscribe:${userId}`);
      original(userId);
    };
    const { res } = await callUsers(db, "DELETE", "/", assertedHeaders(NOSTR.toUpperCase()), undefined, pool);
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ removed: 1 });
    expect(events).toEqual([`find:${NOSTR}`, `delete:${NOSTR}`, "unsubscribe:5"]);
  });
});

Deno.test("DELETE /users answers removed 0 for an account without a row and keeps subscriptions", async () => {
  await withSecret(SECRET, async () => {
    const { db } = abandonRepo(null, 0);
    const { res, pool } = await callUsers(db, "DELETE", "/", assertedHeaders());
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ removed: 0 });
    expect(pool.unsubscribed).toEqual([]);
  });
});

Deno.test("DELETE /users needs the secret and then the npub header", async () => {
  await withSecret(SECRET, async () => {
    const { db, events } = abandonRepo({ id: 5 }, 1);
    const noSecret = await callUsers(db, "DELETE", "/", { [NPUB_HEADER]: NOSTR });
    expect(noSecret.res.status).toEqual(403);
    const noNpub = await callUsers(db, "DELETE", "/", secretHeaders());
    expect(noNpub.res.status).toEqual(400);
    expect(await noNpub.res.json()).toEqual({ status: "ERROR", reason: "missing or invalid npub assertion" });
    expect(events).toEqual([]);
  });
  await withSecret(undefined, async () => {
    const { db } = abandonRepo({ id: 5 }, 1);
    const { res } = await callUsers(db, "DELETE", "/", assertedHeaders());
    expect(res.status).toEqual(503);
  });
});
