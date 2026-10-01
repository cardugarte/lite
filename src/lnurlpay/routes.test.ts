import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { secp256k1 } from "npm:@noble/curves@1.2.0/secp256k1";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, concatBytes, utf8ToBytes } from "npm:@noble/hashes@1.3.1/utils";
import type { RegisterResult, UserRow } from "../db/db.ts";
import { logger } from "../logger.ts";
import { createLnurlpayApp } from "./routes.ts";
import type { LnurlpayRepository } from "./service.ts";

// ---------------------------------------------------------------------------
// Fixtures. Messages are typed out here on purpose: the expected bytes never
// come from Lite's own builders.
// ---------------------------------------------------------------------------

const DOMAIN = "lite-dev.travelsats.ar";
const NOW_S = 1_700_000_000;
const KEY = new Uint8Array(32).fill(0x11);
const PUBKEY = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const OTHER_KEY = new Uint8Array(32).fill(0x22);
const OTHER_PUBKEY = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const NON_CURVE_PUBKEY = "020000000000000000000000000000000000000000000000000000000000000005";
const NPUB = "aa".repeat(32);
const DESCRIPTION = "Sats for alice";

const descHash = (description: string) => bytesToHex(sha256(utf8ToBytes(description)));
const messages = {
  register: (d: string, u: string, desc: string, ts: number) =>
    `breez-lnurl:v2\nregister\n${d}\n${u}\n${descHash(desc)}\n${ts}`,
  unregister: (d: string, u: string, ts: number) => `breez-lnurl:v2\nunregister\n${d}\n${u}\n${ts}`,
  recover: (d: string, pk: string, ts: number) => `breez-lnurl:v2\nrecover\n${d}\n${pk}\n${ts}`,
  available: (d: string, pk: string, u: string, ts: number) =>
    `breez-lnurl:v2\navailable\n${d}\n${pk}\n${u}\n${ts}`,
};
const statementHashOf = (pubkey: string, message: string) =>
  bytesToHex(sha256(concatBytes(utf8ToBytes(pubkey), new Uint8Array([0]), utf8ToBytes(message))));

function signDer(message: string, key = KEY): string {
  return secp256k1.sign(sha256(utf8ToBytes(message)), key).toDERHex();
}

function highSTwin(message: string): string {
  const signature = secp256k1.sign(sha256(utf8ToBytes(message)), KEY);
  return new secp256k1.Signature(signature.r, secp256k1.CURVE.n - signature.s).toDERHex();
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 7,
    username: "alice",
    nostrPubkey: NPUB,
    destination: "spark",
    sparkIdentityPubkey: PUBKEY,
    encryptedConnectionSecret: null,
    ...overrides,
  };
}

type RepoCall = { method: string; args: unknown[] };

type RepoState = {
  register?: RegisterResult | Error;
  byKey?: (pubkey: string) => UserRow | null;
  byName?: (username: string) => UserRow | null;
  intent?: (username: string) => { nostrPubkey: string; sparkPubkey: string } | null;
};

function makeRepo(state: RepoState = {}) {
  const calls: RepoCall[] = [];
  const repo: LnurlpayRepository = {
    registerSparkAddress: async (...args) => {
      calls.push({ method: "registerSparkAddress", args });
      const result = state.register ?? { kind: "created", user: userRow(), previous: null };
      if (result instanceof Error) throw result;
      return result;
    },
    findUserBySparkPubkey: async (...args) => {
      calls.push({ method: "findUserBySparkPubkey", args });
      return state.byKey ? state.byKey(args[0]) : null;
    },
    findUserByUsername: async (...args) => {
      calls.push({ method: "findUserByUsername", args });
      return state.byName ? state.byName(args[0]) : null;
    },
    findActiveBindingIntent: async (...args) => {
      calls.push({ method: "findActiveBindingIntent", args });
      return state.intent ? state.intent(args[0]) : null;
    },
  };
  return { repo, calls };
}

const observed: number[] = [];

function build(options: { state?: RepoState; domain?: string; nowS?: number } = {}) {
  const { repo, calls } = makeRepo(options.state);
  const unsubscribed: number[] = [];
  const app = createLnurlpayApp({
    repo,
    nwcPool: { unsubscribeUser: (id: number) => void unsubscribed.push(id) },
    domain: options.domain ?? DOMAIN,
    now: () => new Date((options.nowS ?? NOW_S) * 1000),
  });
  return { app, calls, unsubscribed };
}

type Built = ReturnType<typeof build>;
type RouteName = "register" | "unregister" | "recover" | "available";

type Fixture = {
  path: string;
  method: string;
  body: Record<string, unknown>;
};

/** A correctly signed request for `route`, with per-field overrides to break it. */
function fixture(
  route: RouteName,
  overrides: Partial<{
    username: string;
    signedUsername: string;
    description: string;
    signedDescription: string;
    ts: number;
    signedTs: number;
    signedDomain: string;
    pathPubkey: string;
    signedPubkey: string;
    key: typeof KEY;
    signature: string;
    signMessage: string;
  }> = {},
): Fixture {
  const username = overrides.username ?? "alice";
  const signedUsername = overrides.signedUsername ?? username.trim().toLowerCase();
  const description = overrides.description ?? DESCRIPTION;
  const ts = overrides.ts ?? NOW_S;
  const signedTs = overrides.signedTs ?? ts;
  const domain = overrides.signedDomain ?? DOMAIN;
  const signedPubkey = overrides.signedPubkey ?? PUBKEY;
  const pathPubkey = overrides.pathPubkey ?? PUBKEY;
  const message = overrides.signMessage ?? {
    register: messages.register(domain, signedUsername, overrides.signedDescription ?? description, signedTs),
    unregister: messages.unregister(domain, signedUsername, signedTs),
    recover: messages.recover(domain, signedPubkey, signedTs),
    available: messages.available(domain, signedPubkey, signedUsername, signedTs),
  }[route];
  const signature = overrides.signature ?? signDer(message, overrides.key ?? KEY);
  const common = { signature, timestamp: ts };
  switch (route) {
    case "register":
      return { path: `/${pathPubkey}`, method: "POST", body: { username, description, ...common } };
    case "unregister":
      return { path: `/${pathPubkey}`, method: "DELETE", body: { username, ...common } };
    case "recover":
      return { path: `/${pathPubkey}/recover`, method: "POST", body: common };
    case "available":
      return { path: `/${pathPubkey}/available`, method: "POST", body: { username, ...common } };
  }
}

async function send(
  built: Built,
  item: { path: string; method: string; body?: unknown },
  headers: Record<string, string> = {},
) {
  const payload = item.body === undefined
    ? undefined
    : typeof item.body === "string"
    ? item.body
    : JSON.stringify(item.body);
  const res = await built.app.request(item.path, {
    method: item.method,
    headers: { "Content-Type": "application/json", ...headers },
    body: payload,
  });
  observed.push(res.status);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

const ROUTES: RouteName[] = ["register", "unregister", "recover", "available"];

// ---------------------------------------------------------------------------
// L8.2: request pipeline and closed status set
// ---------------------------------------------------------------------------

Deno.test("bodies that are not requests are 400 invalid request", async () => {
  const built = build();
  const bodies: unknown[] = [
    "not json",
    "{}",
    "[]",
    "null",
    { username: "alice", signature: "00", timestamp: -1 },
    { username: "alice", signature: 5, timestamp: NOW_S },
    { username: "alice", signature: "00", timestamp: "1700000000" },
    { username: "alice", signature: "00", timestamp: 1.5 },
    { username: "alice", signature: "00", timestamp: Number.MAX_SAFE_INTEGER + 2 },
    { signature: "00", timestamp: NOW_S },
    { username: 7, signature: "00", timestamp: NOW_S },
  ];
  for (const body of bodies) {
    const { res, json } = await send(built, { path: `/${PUBKEY}/available`, method: "POST", body });
    expect({ body, status: res.status, json }).toEqual({ body, status: 400, json: "invalid request" });
  }
  expect(built.calls).toEqual([]);
});

Deno.test("username length and pattern are checked before the description and the signature", async () => {
  const built = build();
  const cases: Array<[string, string]> = [
    ["a".repeat(65), "username too long"],
    ["has space", "invalid username"],
    ["a..b", "invalid username"],
    [".a", "invalid username"],
    ["", "invalid username"],
  ];
  for (const [username, reason] of cases) {
    for (const route of ["register", "unregister", "available"] as const) {
      const request = fixture(route, { username, signature: "garbage" });
      const { res, json } = await send(built, request);
      expect({ route, username, status: res.status, json }).toEqual({ route, username, status: 400, json: reason });
    }
  }
  expect(built.calls).toEqual([]);
});

Deno.test("a padded mixed-case username verifies against its normalized form", async () => {
  const built = build();
  const request = fixture("available", { username: "  Alice " });
  const { res, json } = await send(built, request);
  expect(res.status).toEqual(200);
  expect(json).toEqual({ available: true });
  expect(built.calls.map((call) => [call.method, call.args[0]])).toContainEqual(["findUserByUsername", "alice"]);
});

Deno.test("description is required, a string, and at most 255 code points", async () => {
  const built = build();
  const missing = fixture("register");
  delete missing.body.description;
  const numeric = fixture("register");
  numeric.body.description = 42;
  const nullish = fixture("register");
  nullish.body.description = null;
  for (const request of [missing, numeric, nullish]) {
    const { res, json } = await send(built, request);
    expect({ status: res.status, json }).toEqual({ status: 400, json: "description required" });
  }
  const tooLong = fixture("register", { description: "\u{1F600}".repeat(256) });
  const long = await send(built, tooLong);
  expect({ status: long.res.status, json: long.json }).toEqual({ status: 400, json: "description too long" });
  expect(built.calls).toEqual([]);

  for (const description of ["\u{1F600}".repeat(255), ""]) {
    const { res } = await send(built, fixture("register", { description }));
    expect(res.status).toEqual(200);
  }
  expect(built.calls.filter((call) => call.method === "registerSparkAddress").length).toEqual(2);
});

Deno.test("pubkey and signature encodings are rejected with their own messages", async () => {
  const built = build();
  const pubkeyCases = ["zz", NON_CURVE_PUBKEY, PUBKEY.slice(0, 64)];
  for (const pathPubkey of pubkeyCases) {
    const { res, json } = await send(built, fixture("available", { pathPubkey }));
    expect({ pathPubkey, status: res.status, json }).toEqual({ pathPubkey, status: 400, json: "invalid pubkey" });
  }
  const compact = secp256k1.sign(sha256(utf8ToBytes(messages.recover(DOMAIN, PUBKEY, NOW_S))), KEY).toCompactHex();
  for (const signature of ["not-hex", "abcd", compact]) {
    const { res, json } = await send(built, fixture("recover", { signature }));
    expect({ signature: signature.slice(0, 8), status: res.status, json }).toEqual({
      signature: signature.slice(0, 8),
      status: 400,
      json: "invalid signature",
    });
  }
  expect(built.calls).toEqual([]);
});

Deno.test("an uppercase path pubkey verifies against the lowercase key", async () => {
  const built = build();
  const { res, json } = await send(built, fixture("recover", { pathPubkey: PUBKEY.toUpperCase() }));
  expect(res.status).toEqual(404);
  expect(json).toEqual("user not found");
  expect(built.calls.map((call) => call.args[0])).toEqual([PUBKEY]);
});

Deno.test("the timestamp window is inclusive at plus or minus 600 seconds", async () => {
  const built = build();
  for (const ts of [NOW_S - 600, NOW_S + 600]) {
    const { res } = await send(built, fixture("available", { ts }));
    expect({ ts, status: res.status }).toEqual({ ts, status: 200 });
  }
  for (const ts of [NOW_S - 601, NOW_S + 601]) {
    const { res, json } = await send(built, fixture("available", { ts }));
    expect({ ts, status: res.status, json }).toEqual({ ts, status: 400, json: "invalid timestamp" });
  }
});

Deno.test("a stale timestamp with a garbage signature that parses as DER never reaches verification", async () => {
  const built = build();
  const wrongMessageSignature = signDer("something else entirely");
  const { res, json } = await send(
    built,
    fixture("available", { ts: NOW_S - 601, signature: wrongMessageSignature }),
  );
  expect({ status: res.status, json }).toEqual({ status: 400, json: "invalid timestamp" });
  const fresh = await send(built, fixture("available", { signature: wrongMessageSignature }));
  expect(fresh.json).toEqual(`invalid signature for domain '${DOMAIN}'`);
});

Deno.test("a signature is bound to its route, fields, key, and encoding", async () => {
  const built = build();
  const reason = `invalid signature for domain '${DOMAIN}'`;
  const failing: Array<[string, Fixture]> = [
    [
      "recover signature on available",
      fixture("available", { signMessage: messages.recover(DOMAIN, PUBKEY, NOW_S) }),
    ],
    ["other username", fixture("register", { username: "alicf", signedUsername: "alice" })],
    ["other description", fixture("register", { description: "changed", signedDescription: DESCRIPTION })],
    ["timestamp plus one", fixture("register", { ts: NOW_S + 1, signedTs: NOW_S })],
    ["wrong key", fixture("recover", { key: OTHER_KEY })],
    [
      "high-S twin",
      fixture("recover", { signature: highSTwin(messages.recover(DOMAIN, PUBKEY, NOW_S)) }),
    ],
    ["legacy message", fixture("register", { signMessage: `alice-${NOW_S}` })],
    ["other domain", fixture("register", { signedDomain: "travelsats.ar" })],
    ["pubkey field in the message differs", fixture("available", { signedPubkey: OTHER_PUBKEY })],
  ];
  for (const [name, request] of failing) {
    const { res, json } = await send(built, request);
    expect({ name, status: res.status, json }).toEqual({ name, status: 400, json: reason });
  }
  expect(built.calls).toEqual([]);
});

Deno.test("the signed domain is the configured LNURL domain, never the request Host", async () => {
  const built = build();
  const viaHost = await send(built, fixture("available"), { Host: "other.example" });
  expect(viaHost.res.status).toEqual(200);
  const signedForHost = await send(
    built,
    fixture("available", { signedDomain: "other.example" }),
    { Host: "other.example" },
  );
  expect({ status: signedForHost.res.status, json: signedForHost.json }).toEqual({
    status: 400,
    json: `invalid signature for domain '${DOMAIN}'`,
  });

  const prod = build({ domain: "travelsats.ar" });
  const devSignature = await send(prod, fixture("available"));
  expect({ status: devSignature.res.status, json: devSignature.json }).toEqual({
    status: 400,
    json: "invalid signature for domain 'travelsats.ar'",
  });
  const prodSignature = await send(prod, fixture("available", { signedDomain: "travelsats.ar" }));
  expect(prodSignature.res.status).toEqual(200);
});

Deno.test("valid signatures from the test key pass checks 1 to 8 for every route", async () => {
  for (const route of ROUTES) {
    const built = build();
    const { res } = await send(built, fixture(route));
    expect({ route, rejected: res.status === 400 }).toEqual({ route, rejected: false });
    expect(built.calls.length).toBeGreaterThan(0);
  }
});

Deno.test("unsupported routes answer 404 with a JSON string body", async () => {
  const built = build();
  const transfer = await send(built, { path: `/${PUBKEY}/transfer`, method: "POST", body: {} });
  const available = await send(built, { path: "/available/alice", method: "GET" });
  const root = await send(built, { path: `/${PUBKEY}`, method: "GET" });
  const put = await send(built, { path: `/${PUBKEY}`, method: "PUT", body: {} });
  for (const result of [transfer, available, root, put]) {
    expect(result.res.status).toEqual(404);
    expect(typeof result.json).toEqual("string");
  }
  expect(built.calls).toEqual([]);
});

Deno.test("an invalid signature never touches the repository", async () => {
  for (const route of ROUTES) {
    const built = build();
    const request = fixture(route, { key: OTHER_KEY });
    const { res } = await send(built, request);
    expect({ route, status: res.status }).toEqual({ route, status: 400 });
    expect({ route, calls: built.calls }).toEqual({ route, calls: [] });
  }
});

Deno.test("no route ever answers 401, with or without an Authorization header", async () => {
  const bad: Fixture[] = [];
  for (const route of ROUTES) {
    bad.push(fixture(route, { key: OTHER_KEY }));
    bad.push(fixture(route, { signature: "not-hex" }));
    bad.push(fixture(route, { ts: NOW_S - 9999 }));
    bad.push(fixture(route, { pathPubkey: "zz" }));
    bad.push({ ...fixture(route), body: {} });
  }
  bad.push({ path: `/${PUBKEY}/transfer`, method: "POST", body: {} });
  bad.push({ path: "/zz/metadata", method: "GET", body: {} as never });
  const headerSets: Array<Record<string, string>> = [{}, { Authorization: "Bearer junk" }];
  const statuses = new Set<number>();
  for (const headers of headerSets) {
    for (const request of bad) {
      const built = build();
      const { res, json } = await send(
        built,
        { path: request.path, method: request.method, body: request.method === "GET" ? undefined : request.body },
        headers,
      );
      statuses.add(res.status);
      expect(typeof json).toEqual("string");
    }
  }
  expect(statuses.has(401)).toEqual(false);
  for (const status of statuses) expect([400, 404]).toContain(status);
});

// ---------------------------------------------------------------------------
// L8.3: register
// ---------------------------------------------------------------------------

Deno.test("register answers the exact lnurl body for the configured domain", async () => {
  const built = build();
  const { res, json } = await send(built, fixture("register"));
  expect(res.status).toEqual(200);
  expect(json).toEqual({
    lnurl: "https://lite-dev.travelsats.ar/.well-known/lnurlp/alice",
    lightning_address: "alice@lite-dev.travelsats.ar",
  });
});

Deno.test("register hands the repository one claim with the statement hash and ts + 600 expiry", async () => {
  const built = build();
  const ts = NOW_S - 100;
  await send(built, fixture("register", { ts }));
  expect(built.calls.length).toEqual(1);
  const [call] = built.calls;
  expect(call.method).toEqual("registerSparkAddress");
  const input = call.args[0] as Record<string, unknown>;
  expect(Object.keys(input).sort()).toEqual(["now", "sparkPubkey", "statement", "username"]);
  expect(input.username).toEqual("alice");
  expect(input.sparkPubkey).toEqual(PUBKEY);
  expect(input.now).toEqual(new Date(NOW_S * 1000));
  expect(input.statement).toEqual({
    hash: statementHashOf(PUBKEY, messages.register(DOMAIN, "alice", DESCRIPTION, ts)),
    route: "register",
    expiresAt: new Date((ts + 600) * 1000),
  });
});

Deno.test("a re-signed statement with the same message has the same statement hash", async () => {
  const built = build();
  const message = messages.register(DOMAIN, "alice", DESCRIPTION, NOW_S);
  const first = secp256k1.sign(sha256(utf8ToBytes(message)), KEY, { extraEntropy: true }).toDERHex();
  const second = secp256k1.sign(sha256(utf8ToBytes(message)), KEY, { extraEntropy: true }).toDERHex();
  expect(first).not.toEqual(second);
  await send(built, fixture("register", { signature: first }));
  await send(built, fixture("register", { signature: second }));
  const hashes = built.calls.map((call) => (call.args[0] as { statement: { hash: string } }).statement.hash);
  expect(hashes.length).toEqual(2);
  expect(hashes[0]).toEqual(hashes[1]);
});

Deno.test("each repository result maps to its status and JSON string body", async () => {
  const cases: Array<{ result: RegisterResult; status: number; body: unknown }> = [
    { result: { kind: "no_intent" }, status: 403, body: "no binding intent for this username and pubkey" },
    { result: { kind: "conflict", reason: "statement_used" }, status: 409, body: "signature has already been used" },
    { result: { kind: "conflict", reason: "name_taken" }, status: 409, body: "name already taken" },
    {
      result: { kind: "conflict", reason: "account_username_differs" },
      status: 409,
      body: "account holds a different username",
    },
    { result: { kind: "conflict", reason: "pubkey_taken" }, status: 409, body: "pubkey already holds an address" },
  ];
  for (const item of cases) {
    const built = build({ state: { register: item.result } });
    const { res, json } = await send(built, fixture("register"));
    expect({ status: res.status, json }).toEqual({ status: item.status, json: item.body });
    expect(built.unsubscribed).toEqual([]);
  }
  for (const kind of ["created", "switched", "rotated", "unchanged"] as const) {
    const built = build({ state: { register: { kind, user: userRow(), previous: kind === "created" ? null : "nwc" } } });
    const { res } = await send(built, fixture("register"));
    expect({ kind, status: res.status }).toEqual({ kind, status: 200 });
  }
});

Deno.test("a switched register cancels the NWC subscription once, other results do not", async () => {
  const switched = build({ state: { register: { kind: "switched", user: userRow({ id: 9 }), previous: "nwc" } } });
  await send(switched, fixture("register"));
  expect(switched.unsubscribed).toEqual([9]);
  for (const kind of ["created", "rotated", "unchanged"] as const) {
    const built = build({ state: { register: { kind, user: userRow({ id: 9 }), previous: "spark" } } });
    await send(built, fixture("register"));
    expect({ kind, unsubscribed: built.unsubscribed }).toEqual({ kind, unsubscribed: [] });
  }
});

Deno.test("an unexpected repository error is an opaque 500 JSON string", async () => {
  const built = build({ state: { register: new Error("password authentication failed for user postgres") } });
  const { res, json, text } = await send(built, fixture("register"));
  expect(res.status).toEqual(500);
  expect(json).toEqual("internal error");
  expect(text.includes("password")).toEqual(false);
});

Deno.test("Authorization is ignored: same result with and without, and never logged", async () => {
  const writable = logger as unknown as { levelName: string; handlers: Array<{ levelName: string }> };
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
    const without = await send(build({ state: { register: new Error("boom") } }), fixture("register"));
    const withHeader = await send(
      build({ state: { register: new Error("boom") } }),
      fixture("register"),
      { Authorization: "Bearer KEY-123" },
    );
    expect({ status: withHeader.res.status, json: withHeader.json }).toEqual({
      status: without.res.status,
      json: without.json,
    });
    const ok = await send(build(), fixture("register"), { Authorization: "Bearer KEY-123" });
    expect(ok.res.status).toEqual(200);
  } finally {
    console.log = original;
    writable.levelName = previousLevel;
    writable.handlers.forEach((handler, index) => {
      handler.levelName = previousHandlers[index];
    });
  }
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join("\n").includes("KEY-123")).toEqual(false);
});

// ---------------------------------------------------------------------------
// L8.4: unregister, recover, available, metadata
// ---------------------------------------------------------------------------

Deno.test("the owner cannot unregister; a stale or unbound key gets a harmless 404", async () => {
  const owner = build({ state: { byKey: () => userRow() } });
  const refused = await send(owner, fixture("unregister"));
  expect({ status: refused.res.status, json: refused.json }).toEqual({
    status: 409,
    json: "address cannot be released; switch destination instead",
  });
  // Regardless of the signed username.
  const otherName = await send(owner, fixture("unregister", { username: "bob" }));
  expect(otherName.res.status).toEqual(409);
  expect(owner.calls.every((call) => call.method === "findUserBySparkPubkey")).toEqual(true);

  const stale = build({ state: { byKey: () => null } });
  const gone = await send(stale, fixture("unregister"));
  expect({ status: gone.res.status, json: gone.json }).toEqual({ status: 404, json: "user not found" });
  expect(stale.calls.every((call) => call.method === "findUserBySparkPubkey")).toEqual(true);
});

Deno.test("unregister never answers 2xx and never claims or writes", async () => {
  const states: RepoState[] = [{ byKey: () => userRow() }, { byKey: () => null }, { byKey: () => userRow({ destination: "nwc", sparkIdentityPubkey: null }) }];
  for (const state of states) {
    const built = build({ state });
    const { res } = await send(built, fixture("unregister"));
    expect(res.status >= 200 && res.status < 300).toEqual(false);
    expect(built.calls.some((call) => call.method === "registerSparkAddress")).toEqual(false);
  }
});

Deno.test("recover returns the full body for a bound key and 404 for unbound or former keys", async () => {
  const bound = build({ state: { byKey: () => userRow() } });
  const found = await send(bound, fixture("recover"));
  expect(found.res.status).toEqual(200);
  expect(found.json).toEqual({
    lnurl: "https://lite-dev.travelsats.ar/.well-known/lnurlp/alice",
    lightning_address: "alice@lite-dev.travelsats.ar",
    username: "alice",
    description: "Sats for alice",
  });
  expect(bound.calls).toEqual([{ method: "findUserBySparkPubkey", args: [PUBKEY] }]);

  const unbound = build({ state: { byKey: () => null } });
  const missing = await send(unbound, fixture("recover"));
  expect({ status: missing.res.status, json: missing.json }).toEqual({ status: 404, json: "user not found" });
});

Deno.test("available follows the name-and-intent matrix", async () => {
  const intentFor = (sparkPubkey: string) => () => ({ nostrPubkey: "bb".repeat(32), sparkPubkey });
  const matrix: Array<{ name: string; state: RepoState; username?: string; expected: boolean }> = [
    { name: "free name", state: {}, username: "carol", expected: true },
    {
      name: "spark row bound to the asking key",
      state: { byName: () => userRow() },
      expected: true,
    },
    {
      name: "spark row bound to another key",
      state: { byName: () => userRow({ sparkIdentityPubkey: OTHER_PUBKEY }) },
      expected: false,
    },
    {
      name: "nwc row without an intent",
      state: { byName: () => userRow({ destination: "nwc", sparkIdentityPubkey: null }) },
      expected: false,
    },
    {
      name: "nwc row with an intent for the asking key",
      state: {
        byName: () => userRow({ destination: "nwc", sparkIdentityPubkey: null }),
        intent: intentFor(PUBKEY),
      },
      expected: false,
    },
    { name: "free name with an intent for another key", state: { intent: intentFor(OTHER_PUBKEY) }, username: "carol", expected: false },
    { name: "free name with an intent for the asking key", state: { intent: intentFor(PUBKEY) }, username: "carol", expected: true },
    { name: "free name with an expired foreign intent (repository returns none)", state: { intent: () => null }, username: "carol", expected: true },
  ];
  for (const item of matrix) {
    const built = build({ state: item.state });
    const { res, json } = await send(built, fixture("available", { username: item.username ?? "alice" }));
    expect({ name: item.name, status: res.status, json }).toEqual({
      name: item.name,
      status: 200,
      json: { available: item.expected },
    });
  }
});

Deno.test("repeated identical unregister, recover, and available requests are never 409 and claim nothing", async () => {
  const built = build({ state: { byKey: () => null } });
  for (const route of ["unregister", "recover", "available"] as const) {
    const request = fixture(route);
    const first = await send(built, request);
    const second = await send(built, request);
    expect({ route, first: first.res.status, second: second.res.status }).toEqual({
      route,
      first: first.res.status,
      second: first.res.status,
    });
    expect(first.res.status).not.toEqual(409);
  }
  expect(built.calls.some((call) => call.method === "registerSparkAddress")).toEqual(false);
});

Deno.test("metadata serves an empty page without a signature, a database read, or caching", async () => {
  const built = build();
  const { res, json } = await send(built, { path: `/${PUBKEY}/metadata`, method: "GET" });
  expect(res.status).toEqual(200);
  expect(json).toEqual({ metadata: [] });
  expect(res.headers.get("Cache-Control")).toEqual("no-store, private");
  const upper = await send(built, { path: `/${PUBKEY.toUpperCase()}/metadata`, method: "GET" });
  expect(upper.res.status).toEqual(200);
  const bad = await send(built, { path: "/zz/metadata", method: "GET" });
  expect({ status: bad.res.status, json: bad.json }).toEqual({ status: 400, json: "invalid pubkey" });
  expect(built.calls).toEqual([]);
});

// ---------------------------------------------------------------------------
// The status set of every response collected above is closed.
// ---------------------------------------------------------------------------

Deno.test("every status observed in this file is in the closed set", () => {
  expect(observed.length).toBeGreaterThan(50);
  const allowed = new Set([200, 204, 400, 403, 404, 409, 413, 500]);
  const outside = [...new Set(observed)].filter((status) => !allowed.has(status));
  expect(outside).toEqual([]);
});
