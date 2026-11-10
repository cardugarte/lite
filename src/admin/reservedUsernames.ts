import { Hono } from "hono";
import type { Context } from "hono";
import { errorEnvelope } from "../auth/bff.ts";
import { requireAdminToken } from "../auth/admin.ts";
import type { DB, ReservedUsernameRecord } from "../db/db.ts";
import { normalizeReservedName } from "../db/reservedUsernames.ts";
import { isValid32ByteHex } from "../utils.ts";

const CATEGORIES = new Set(["hard", "assignable"]);
const MATCHES = new Set(["exact", "prefix", "contains"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function rowJson(row: ReservedUsernameRecord) {
  return {
    name: row.name,
    category: row.category,
    match: row.match,
    assigned_nostr_pubkey: row.assignedNostrPubkey,
  };
}

function readMatch(c: Context): { ok: true; match: "exact" | "prefix" | "contains" } | { ok: false; response: Response } {
  const match = c.req.query("match");
  if (!match || !MATCHES.has(match)) {
    return { ok: false, response: c.json(errorEnvelope("invalid match"), 400) };
  }
  return { ok: true, match: match as "exact" | "prefix" | "contains" };
}

/** Admin maintenance of `reserved_usernames`. No anonymous access. */
export function createAdminReservedApp(db: DB) {
  const hono = new Hono();

  hono.use("*", async (c, next) => {
    const denied = requireAdminToken(c);
    if (denied) return denied;
    await next();
  });

  hono.get("/", async (c) => {
    const q = normalizeReservedName(c.req.query("q") ?? "");
    const category = c.req.query("category") ?? null;
    const match = c.req.query("match") ?? null;
    if (category && !CATEGORIES.has(category)) return c.json(errorEnvelope("invalid category"), 400);
    if (match && !MATCHES.has(match)) return c.json(errorEnvelope("invalid match"), 400);
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isInteger(offset) || offset < 0) {
      return c.json(errorEnvelope("invalid pagination"), 400);
    }
    const page = await db.listReservedUsernames({ q, category, match, limit, offset });
    return c.json({
      usernames: page.rows.map(rowJson),
      total: page.total,
      limit,
      offset,
    });
  });

  hono.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorEnvelope("invalid json"), 400);
    }
    if (typeof body !== "object" || body === null) return c.json(errorEnvelope("invalid request"), 400);
    const fields = body as Record<string, unknown>;
    if (typeof fields.name !== "string" || typeof fields.category !== "string" || typeof fields.match !== "string") {
      return c.json(errorEnvelope("invalid request"), 400);
    }
    const name = normalizeReservedName(fields.name);
    if (!name || !CATEGORIES.has(fields.category) || !MATCHES.has(fields.match)) {
      return c.json(errorEnvelope("invalid request"), 400);
    }
    const created = await db.insertReservedUsername({
      name,
      category: fields.category as "hard" | "assignable",
      match: fields.match as "exact" | "prefix" | "contains",
    });
    if (created.kind === "conflict") return c.json(errorEnvelope("already exists"), 409);
    return c.json(rowJson(created.row), 201);
  });

  hono.patch("/:name", async (c) => {
    const match = readMatch(c);
    if (!match.ok) return match.response;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorEnvelope("invalid json"), 400);
    }
    const category = typeof body === "object" && body !== null ? (body as { category?: unknown }).category : undefined;
    if (typeof category !== "string" || !CATEGORIES.has(category)) {
      return c.json(errorEnvelope("invalid request"), 400);
    }
    const row = await db.updateReservedCategory(
      normalizeReservedName(c.req.param("name")),
      match.match,
      category as "hard" | "assignable",
    );
    if (!row) return c.json(errorEnvelope("not found"), 404);
    return c.json(rowJson(row));
  });

  hono.put("/:name/assignment", async (c) => {
    const match = readMatch(c);
    if (!match.ok) return match.response;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorEnvelope("invalid json"), 400);
    }
    const pubkey = typeof body === "object" && body !== null
      ? (body as { nostr_pubkey?: unknown }).nostr_pubkey
      : undefined;
    if (typeof pubkey !== "string" || !isValid32ByteHex(pubkey)) {
      return c.json(errorEnvelope("invalid pubkey"), 400);
    }
    // Any 64-hex pubkey. Lite does not check club, role, or provider verification.
    const result = await db.assignReservedUsername(
      normalizeReservedName(c.req.param("name")),
      match.match,
      pubkey.toLowerCase(),
    );
    if (result.kind === "not_found") return c.json(errorEnvelope("not found"), 404);
    if (result.kind === "not_assignable") return c.json(errorEnvelope("not assignable"), 409);
    return c.json(rowJson(result.row));
  });

  hono.delete("/:name/assignment", async (c) => {
    const match = readMatch(c);
    if (!match.ok) return match.response;
    const row = await db.clearReservedAssignment(normalizeReservedName(c.req.param("name")), match.match);
    if (!row) return c.json(errorEnvelope("not found"), 404);
    return c.json(rowJson(row));
  });

  hono.delete("/:name", async (c) => {
    const match = readMatch(c);
    if (!match.ok) return match.response;
    const removed = await db.deleteReservedUsername(normalizeReservedName(c.req.param("name")), match.match);
    if (removed === 0) return c.json(errorEnvelope("not found"), 404);
    return c.json({ removed });
  });

  return hono;
}
