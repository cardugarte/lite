import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "../db/db.ts";
import { createAdminReservedApp } from "./reservedUsernames.ts";

const TOKEN = "admin-token-value";
const PUBKEY = "aa".repeat(32);

type Row = { name: string; category: "hard" | "assignable"; match: "exact" | "prefix" | "contains"; assignedNostrPubkey: string | null };

function store(seed: Row[] = []) {
  const rows = seed.map((row) => ({ ...row }));
  const db = {
    listReservedUsernames: async (query: { q: string; category: string | null; match: string | null; limit: number; offset: number }) => {
      const filtered = rows.filter((row) => {
        if (query.q && !row.name.includes(query.q)) return false;
        if (query.category && row.category !== query.category) return false;
        if (query.match && row.match !== query.match) return false;
        return true;
      });
      return { rows: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
    },
    insertReservedUsername: async (row: Row) => {
      if (rows.some((item) => item.name === row.name && item.match === row.match)) return { kind: "conflict" as const };
      rows.push({ ...row, assignedNostrPubkey: null });
      return { kind: "created" as const, row: rows[rows.length - 1] };
    },
    deleteReservedUsername: async (name: string, match: string) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].name === name && rows[i].match === match) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    updateReservedCategory: async (name: string, match: string, category: "hard" | "assignable") => {
      const row = rows.find((item) => item.name === name && item.match === match);
      if (!row) return null;
      row.category = category;
      if (category === "hard") row.assignedNostrPubkey = null;
      return row;
    },
    assignReservedUsername: async (name: string, match: string, pubkey: string) => {
      const row = rows.find((item) => item.name === name && item.match === match);
      if (!row) return { kind: "not_found" as const };
      if (row.category !== "assignable") return { kind: "not_assignable" as const };
      row.assignedNostrPubkey = pubkey;
      return { kind: "assigned" as const, row };
    },
    clearReservedAssignment: async (name: string, match: string) => {
      const row = rows.find((item) => item.name === name && item.match === match);
      if (!row) return null;
      row.assignedNostrPubkey = null;
      return row;
    },
  } as unknown as DB;
  return { db, rows };
}

async function withToken<T>(fn: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("LITE_ADMIN_TOKEN");
  Deno.env.set("LITE_ADMIN_TOKEN", TOKEN);
  try {
    return await fn();
  } finally {
    if (previous == null) Deno.env.delete("LITE_ADMIN_TOKEN");
    else Deno.env.set("LITE_ADMIN_TOKEN", previous);
  }
}

function auth(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

Deno.test("PUT assignment accepts any valid pubkey and does not look up the assignee", async () => {
  await withToken(async () => {
    const stranger = "cd".repeat(32);
    const lookedUp: string[] = [];
    const { db } = store([{ name: "sanmartin", category: "assignable", match: "exact", assignedNostrPubkey: null }]);
    (db as unknown as { findUserByNostrPubkey: () => Promise<never> }).findUserByNostrPubkey = async () => {
      lookedUp.push("user");
      throw new Error("eligibility lookup");
    };
    const app = createAdminReservedApp(db);
    const res = await app.request("/sanmartin/assignment?match=exact", {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ nostr_pubkey: stranger.toUpperCase() }),
    });
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({
      name: "sanmartin",
      category: "assignable",
      match: "exact",
      assigned_nostr_pubkey: stranger,
    });
    expect(lookedUp).toEqual([]);
  });
});

Deno.test("admin reserved-username routes reject anonymous callers", async () => {
  await withToken(async () => {
    const { db } = store();
    const app = createAdminReservedApp(db);
    const missing = await app.request("/?limit=1");
    expect(missing.status).toEqual(401);
    const wrong = await app.request("/", { headers: { Authorization: "Bearer not-the-token" } });
    expect(wrong.status).toEqual(403);
  });
});

Deno.test("admin can list, add, retarget, assign, and delete a reserved name", async () => {
  await withToken(async () => {
    const { db, rows } = store([
      { name: "admin", category: "hard", match: "exact", assignedNostrPubkey: null },
      { name: "admin", category: "hard", match: "prefix", assignedNostrPubkey: null },
      { name: "mendoza", category: "assignable", match: "exact", assignedNostrPubkey: null },
    ]);
    const app = createAdminReservedApp(db);
    const listed = await app.request("/?q=adm&match=exact", { headers: auth() });
    expect(listed.status).toEqual(200);
    expect(await listed.json()).toEqual({
      usernames: [{ name: "admin", category: "hard", match: "exact", assigned_nostr_pubkey: null }],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const created = await app.request("/", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: " Foo.Bar ", category: "hard", match: "exact" }),
    });
    expect(created.status).toEqual(201);
    expect(await created.json()).toEqual({
      name: "foobar",
      category: "hard",
      match: "exact",
      assigned_nostr_pubkey: null,
    });

    const duplicate = await app.request("/", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "foobar", category: "hard", match: "exact" }),
    });
    expect(duplicate.status).toEqual(409);

    const assigned = await app.request("/mendoza/assignment?match=exact", {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ nostr_pubkey: PUBKEY.toUpperCase() }),
    });
    expect(assigned.status).toEqual(200);
    expect(await assigned.json()).toEqual({
      name: "mendoza",
      category: "assignable",
      match: "exact",
      assigned_nostr_pubkey: PUBKEY,
    });

    const cleared = await app.request("/mendoza/assignment?match=exact", { method: "DELETE", headers: auth() });
    expect(cleared.status).toEqual(200);
    expect((await cleared.json()).assigned_nostr_pubkey).toEqual(null);
    const reassigned = await app.request("/mendoza/assignment?match=exact", {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ nostr_pubkey: PUBKEY }),
    });
    expect(reassigned.status).toEqual(200);

    const hardAssign = await app.request("/admin/assignment?match=exact", {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ nostr_pubkey: PUBKEY }),
    });
    expect(hardAssign.status).toEqual(409);
    expect(await hardAssign.json()).toEqual({ status: "ERROR", reason: "not assignable" });

    const badKey = await app.request("/mendoza/assignment?match=exact", {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ nostr_pubkey: "npub1qqq" }),
    });
    expect(badKey.status).toEqual(400);

    const patched = await app.request("/mendoza?match=exact", {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ category: "hard" }),
    });
    expect(patched.status).toEqual(200);
    expect(await patched.json()).toEqual({
      name: "mendoza",
      category: "hard",
      match: "exact",
      assigned_nostr_pubkey: null,
    });

    const removed = await app.request("/foobar?match=exact", { method: "DELETE", headers: auth() });
    expect(removed.status).toEqual(200);
    expect(await removed.json()).toEqual({ removed: 1 });
    const missing = await app.request("/nope?match=exact", { method: "DELETE", headers: auth() });
    expect(missing.status).toEqual(404);
    expect(rows.some((row) => row.name === "foobar")).toEqual(false);
  });
});
