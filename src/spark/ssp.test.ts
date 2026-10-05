import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { secp256k1 } from "npm:@noble/curves@1.2.0/secp256k1";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import { captureLogs } from "../test_logs.ts";
import { createBreezIdentitySigner } from "./breezMinter.ts";
import { createSspClient, SSP_GRAPHQL_URL, type SparkIdentitySigner, SspError } from "./ssp.ts";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const IDENTITY_HEX = "02" + "ab".repeat(32);
const RECEIVER = "03" + "cd".repeat(32);
const HASH = "34886256fe9caf760ffb1f88c356d1c7f2b481a5899af4c7111aa462fb74d773";
const PREIMAGE = "ab".repeat(32);
const T0 = Date.parse("2026-10-04T16:00:00Z");
/** None of these may ever reach an error message or a log line. */
const SESSION = (n: number) => `session-token-secret-${n}`;

/** A valid compact signature: r and s are below the curve order. */
const COMPACT = new Uint8Array([...new Array(32).fill(0x11), ...new Array(32).fill(0x22)]);

// ---- fixtures with the shapes the SSP returned on mainnet (2026-10-04) ----

const unpaid = (hash = HASH, createdAt = "2026-10-04T15:56:14.269893+00:00") => ({
  __typename: "LightningReceiveRequest",
  id: "SparkLightningReceiveRequest:019bd1c2-5e0a-7d10-b3a4-7f2c1e0a9b11",
  created_at: createdAt,
  updated_at: createdAt,
  request_status: "CREATED",
  status: "INVOICE_CREATED",
  payment_preimage: null,
  receiver_identity_public_key: null,
  invoice: { payment_hash: hash, created_at: createdAt, expires_at: "2026-10-04T16:01:14.269893+00:00" },
});

const paid = (hash = HASH, preimage = PREIMAGE) => ({
  ...unpaid(hash),
  updated_at: "2026-10-04T16:19:27.130922+00:00",
  request_status: "SUCCEEDED",
  status: "TRANSFER_COMPLETED",
  payment_preimage: preimage,
  receiver_identity_public_key: RECEIVER,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const listBody = (entities: unknown[], pageInfo: unknown = { has_next_page: false, end_cursor: null }) => ({
  data: { current_user: { user_requests: { page_info: pageInfo, entities } } },
});

type Call = {
  operationName: string;
  query: string;
  // deno-lint-ignore no-explicit-any
  variables: Record<string, any>;
  authorization: string | null;
  url: string;
  method: string;
  contentType: string | null;
};

function world(options: {
  list?: (call: Call, n: number) => Response | Promise<Response>;
  challenge?: (call: Call) => Response | Promise<Response>;
  verify?: (call: Call, n: number, now: number) => Response | Promise<Response>;
  signature?: Uint8Array;
  signer?: SparkIdentitySigner;
  client?: Partial<Parameters<typeof createSspClient>[0]>;
} = {}) {
  const calls: Call[] = [];
  const signed: Uint8Array[] = [];
  const counts: Record<string, number> = {};
  let clock = T0;

  const signer: SparkIdentitySigner = options.signer ?? {
    // The real handle returns plain number arrays.
    getIdentityPublicKey: async () => ({ bytes: Array.from(hexToBytes(IDENTITY_HEX)) }),
    signAuthenticationChallenge: async (challenge) => {
      signed.push(challenge);
      return { bytes: Array.from(options.signature ?? COMPACT) };
    },
  };

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    const call: Call = {
      operationName: body.operationName,
      query: body.query,
      variables: body.variables,
      authorization: headers.get("authorization"),
      url: String(input),
      method: String(init?.method),
      contentType: headers.get("content-type"),
    };
    calls.push(call);
    const n = counts[call.operationName] ?? 0;
    counts[call.operationName] = n + 1;
    switch (call.operationName) {
      case "GetChallenge":
        return options.challenge
          ? await options.challenge(call)
          : json({
            data: {
              get_challenge: {
                protected_challenge: b64url(new Uint8Array([1, 2, ...hexToBytes(call.variables.input.public_key), 3])),
              },
            },
          });
      case "VerifyChallenge":
        return options.verify ? await options.verify(call, n, clock) : json({
          data: {
            verify_challenge: {
              valid_until: new Date(clock + 600_000).toISOString(),
              session_token: SESSION(n + 1),
            },
          },
        });
      case "ListLightningReceives":
        return options.list ? await options.list(call, n) : json(listBody([]));
      default:
        throw new Error(`unexpected operation ${call.operationName}`);
    }
  };

  const client = createSspClient({
    getSigner: async () => signer,
    fetch: fetchFn,
    now: () => clock,
    ...options.client,
  });
  return {
    client,
    calls,
    signed,
    names: () => calls.map((call) => call.operationName),
    advance: (ms: number) => void (clock += ms),
  };
}

// ---- authentication ----

Deno.test("it authenticates as the minter identity, signs the challenge, then lists with the session token", async () => {
  const w = world();
  await w.client.listLightningReceives();

  expect(w.names()).toEqual(["GetChallenge", "VerifyChallenge", "ListLightningReceives"]);
  for (const call of w.calls) {
    expect(call.url).toEqual(SSP_GRAPHQL_URL);
    expect(call.method).toEqual("POST");
    expect(call.contentType).toEqual("application/json");
  }
  const [challenge, verify, list] = w.calls;
  expect(challenge.variables).toEqual({ input: { public_key: IDENTITY_HEX } });
  expect(challenge.authorization).toBeNull();

  // The signer is handed exactly the challenge the SSP issued.
  const issued = b64url(new Uint8Array([1, 2, ...hexToBytes(IDENTITY_HEX), 3]));
  expect(w.signed.map(b64url)).toEqual([issued]);
  expect(verify.variables).toEqual({
    input: {
      protected_challenge: issued,
      identity_public_key: IDENTITY_HEX,
      // The signer returned the 64-byte compact form; the SSP takes DER.
      signature: b64url(hexToBytes(secp256k1.Signature.fromCompact(bytesToHex(COMPACT)).toDERHex())),
    },
  });
  expect(verify.authorization).toBeNull();

  expect(list.authorization).toEqual(`Bearer ${SESSION(1)}`);
  expect(list.variables.types).toEqual(["LIGHTNING_RECEIVE"]);
  expect(list.query).toContain("user_requests(first: $first, after: $after, types: $types)");
});

Deno.test("a compact signature becomes the DER the noble curve library writes, whatever its leading bytes", async () => {
  const vectors: Uint8Array[] = [
    COMPACT,
    // high bit set in r and s: DER needs a leading zero byte
    new Uint8Array([...new Array(32).fill(0xf1), ...new Array(32).fill(0x92)]),
    // leading zeros in r and s: DER drops them
    new Uint8Array([0, 0, 0, ...new Array(29).fill(0x33), 0, ...new Array(31).fill(0x44)]),
    // a zero byte followed by a high bit: the zero stays
    new Uint8Array([0, 0x80, ...new Array(30).fill(0x55), 0, 0xff, ...new Array(30).fill(0x66)]),
  ];
  for (const compact of vectors) {
    const w = world({ signature: compact });
    await w.client.listLightningReceives();
    const sent = w.calls[1].variables.input.signature;
    const expected = secp256k1.Signature.fromCompact(bytesToHex(compact)).toDERHex();
    expect({ compact: bytesToHex(compact), der: bytesToHex(fromB64url(sent)) }).toEqual({
      compact: bytesToHex(compact),
      der: expected,
    });
  }
});

Deno.test("a signature the signer already returns in DER is sent unchanged", async () => {
  const der = hexToBytes(secp256k1.Signature.fromCompact(bytesToHex(COMPACT)).toDERHex());
  const w = world({ signature: der });
  await w.client.listLightningReceives();
  expect(fromB64url(w.calls[1].variables.input.signature)).toEqual(der);
});

Deno.test("a signature of any other shape is refused before the SSP is asked to verify it", async () => {
  const w = world({ signature: new Uint8Array(10).fill(1) });
  await expect(w.client.listLightningReceives()).rejects.toThrow(SspError);
  expect(w.names()).toEqual(["GetChallenge"]);
});

Deno.test("it refuses to sign a challenge that does not name its own identity key", async () => {
  const w = world({
    challenge: () => json({ data: { get_challenge: { protected_challenge: b64url(new Uint8Array([1, 2, 3, 4])) } } }),
  });
  const error = await w.client.listLightningReceives().catch((e) => e);
  expect(error).toBeInstanceOf(SspError);
  expect(error.kind).toEqual("auth");
  expect(w.signed).toEqual([]);
  expect(w.names()).toEqual(["GetChallenge"]);
});

Deno.test("an incomplete authentication answer is a shape error and caches no session", async () => {
  let broken = true;
  const w = world({
    verify: (_call, n, now) =>
      broken
        ? json({ data: { verify_challenge: { valid_until: "not a date", session_token: SESSION(n + 1) } } })
        : json({ data: { verify_challenge: { valid_until: new Date(now + 600_000).toISOString(), session_token: SESSION(n + 1) } } }),
  });
  const error = await w.client.listLightningReceives().catch((e) => e);
  expect(error).toBeInstanceOf(SspError);
  expect(error.kind).toEqual("shape");
  broken = false;
  await w.client.listLightningReceives();
  expect(w.names().filter((name) => name === "GetChallenge").length).toEqual(2);
});

// ---- the session ----

Deno.test("the session is reused until shortly before valid_until, then renewed", async () => {
  const w = world({
    verify: (_call, n, now) =>
      json({
        data: {
          verify_challenge: {
            // The format the SSP uses: microseconds and a +00:00 offset.
            valid_until: new Date(now + 600_000).toISOString().replace(".000Z", ".000000+00:00"),
            session_token: SESSION(n + 1),
          },
        },
      }),
  });
  const authentications = () => w.names().filter((name) => name === "VerifyChallenge").length;

  await w.client.listLightningReceives();
  w.advance(60_000);
  await w.client.listLightningReceives();
  w.advance(478_000); // 538 s in: more than a minute left
  await w.client.listLightningReceives();
  expect(authentications()).toEqual(1);

  w.advance(3_000); // 541 s in: inside the renewal margin
  await w.client.listLightningReceives();
  expect(authentications()).toEqual(2);
  expect(w.calls.at(-1)?.authorization).toEqual(`Bearer ${SESSION(2)}`);
});

Deno.test("concurrent lists share one authentication", async () => {
  const w = world();
  await Promise.all([w.client.listLightningReceives(), w.client.listLightningReceives(), w.client.listLightningReceives()]);
  expect(w.names().filter((name) => name === "GetChallenge").length).toEqual(1);
  expect(w.names().filter((name) => name === "VerifyChallenge").length).toEqual(1);
});

Deno.test("a rejected session (HTTP 401) is renewed once and the list is retried with the new token", async () => {
  const w = world({
    list: (call) => call.authorization === `Bearer ${SESSION(1)}` ? json({ errors: [{ message: "gone" }] }, 401) : json(listBody([paid()])),
  });
  const page = await w.client.listLightningReceives();
  expect(w.names()).toEqual([
    "GetChallenge",
    "VerifyChallenge",
    "ListLightningReceives",
    "GetChallenge",
    "VerifyChallenge",
    "ListLightningReceives",
  ]);
  expect(w.calls.at(-1)?.authorization).toEqual(`Bearer ${SESSION(2)}`);
  expect(page.entries.length).toEqual(1);
});

Deno.test("an authentication error inside an HTTP 200 body also renews the session once", async () => {
  const w = world({
    list: (call) =>
      call.authorization === `Bearer ${SESSION(1)}`
        ? json({ data: null, errors: [{ message: "Unauthenticated", extensions: { code: "UNAUTHENTICATED" } }] })
        : json(listBody([])),
  });
  await w.client.listLightningReceives();
  expect(w.names().filter((name) => name === "VerifyChallenge").length).toEqual(2);
});

Deno.test("a session that is still rejected after renewal is an auth error, not a loop", async () => {
  const w = world({ list: () => json({ errors: [{ message: "gone" }] }, 401) });
  const error = await w.client.listLightningReceives().catch((e) => e);
  expect(error).toBeInstanceOf(SspError);
  expect(error.kind).toEqual("auth");
  expect(error.status).toEqual(401);
  expect(w.names().filter((name) => name === "ListLightningReceives").length).toEqual(2);
  expect(w.names().filter((name) => name === "VerifyChallenge").length).toEqual(2);
});

// ---- errors ----

Deno.test("HTTP 200 with GraphQL errors is an error, even when data is present", async () => {
  const w = world({
    list: () =>
      json({
        data: listBody([paid()]).data,
        errors: [{ message: "field user_requests is not available", extensions: { code: "SCHEMA_DRIFT" } }],
      }),
  });
  const error = await w.client.listLightningReceives().catch((e) => e);
  expect(error).toBeInstanceOf(SspError);
  expect(error.kind).toEqual("graphql");
  expect(error.message).toContain("field user_requests is not available");
});

Deno.test("transport and server failures are typed errors", async () => {
  const cases: Array<[string, () => Response | Promise<Response>, string, number | undefined]> = [
    ["server error", () => json({}, 500), "http", 500],
    ["rate limited", () => json({}, 429), "http", 429],
    ["not JSON", () => new Response("<html>bad gateway</html>", { status: 200 }), "shape", undefined],
    ["no data", () => json({ foo: 1 }), "shape", undefined],
    ["no user_requests", () => json({ data: { current_user: {} } }), "shape", undefined],
    ["no page_info", () => json(listBody([], null)), "shape", undefined],
    ["page_info without has_next_page", () => json(listBody([], { end_cursor: "c" })), "shape", undefined],
  ];
  for (const [label, list, kind, status] of cases) {
    const error = await world({ list }).client.listLightningReceives().catch((e) => e);
    expect({ label, isSsp: error instanceof SspError, kind: error.kind, status: error.status }).toEqual({
      label,
      isSsp: true,
      kind,
      status,
    });
  }
});

Deno.test("an unreachable SSP is a network error, and so is one that never answers", async () => {
  const unreachable = createSspClient({
    getSigner: async () => ({
      getIdentityPublicKey: async () => ({ bytes: Array.from(hexToBytes(IDENTITY_HEX)) }),
      signAuthenticationChallenge: async () => ({ bytes: Array.from(COMPACT) }),
    }),
    fetch: () => Promise.reject(new TypeError("connection refused")),
  });
  const refused = await unreachable.listLightningReceives().catch((e) => e);
  expect(refused).toBeInstanceOf(SspError);
  expect(refused.kind).toEqual("network");

  const silent = world({
    client: {
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    },
  });
  const timedOut = await silent.client.listLightningReceives().catch((e) => e);
  expect(timedOut).toBeInstanceOf(SspError);
  expect(timedOut.kind).toEqual("network");
  expect(timedOut.message).toContain("timed out");
});

Deno.test("an authentication failure is shared by the callers waiting on it and the next call tries again", async () => {
  let failing = true;
  const w = world({
    verify: (_call, n, now) =>
      failing
        ? json({}, 503)
        : json({ data: { verify_challenge: { valid_until: new Date(now + 600_000).toISOString(), session_token: SESSION(n + 1) } } }),
  });
  const results = await Promise.allSettled([w.client.listLightningReceives(), w.client.listLightningReceives()]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(w.names().filter((name) => name === "VerifyChallenge").length).toEqual(1);
  failing = false;
  await w.client.listLightningReceives();
  expect(w.names().filter((name) => name === "VerifyChallenge").length).toEqual(2);
});

Deno.test("no error message or log line carries the session token, the challenge or the signature", async () => {
  const challenge = b64url(new Uint8Array([1, 2, ...hexToBytes(IDENTITY_HEX), 3]));
  const signature = b64url(hexToBytes(secp256k1.Signature.fromCompact(bytesToHex(COMPACT)).toDERHex()));
  const w = world({
    // A server that echoes what it was sent, token included.
    list: (call) =>
      json({ errors: [{ message: `bad request ${call.authorization} challenge ${challenge} signature ${signature}` }] }),
  });
  const { result: error, raw } = await captureLogs(async () => await w.client.listLightningReceives().catch((e) => e));
  expect(error).toBeInstanceOf(SspError);
  for (const secret of [SESSION(1), challenge, signature]) {
    expect(error.message.includes(secret)).toEqual(false);
    expect(raw.includes(secret)).toEqual(false);
  }
});

// ---- the list ----

Deno.test("a page maps the records it lists and its cursor", async () => {
  const w = world({
    list: () =>
      json(listBody(
        [
          unpaid("aa".repeat(32)),
          paid(),
          { __typename: "SomethingElse" },
          { ...unpaid("bb".repeat(32)), invoice: null },
          { ...unpaid("cc".repeat(32)), status: undefined, extra_field: "ignored" },
        ],
        { has_next_page: true, has_previous_page: false, start_cursor: "s", end_cursor: "cursor-1" },
      )),
  });
  const page = await w.client.listLightningReceives();
  expect(page.hasNextPage).toEqual(true);
  expect(page.endCursor).toEqual("cursor-1");
  expect(page.entries.map((entry) => entry.invoice.payment_hash)).toEqual(["aa".repeat(32), HASH, "cc".repeat(32)]);
  expect(page.entries[0]).toEqual({
    id: "SparkLightningReceiveRequest:019bd1c2-5e0a-7d10-b3a4-7f2c1e0a9b11",
    created_at: "2026-10-04T15:56:14.269893+00:00",
    updated_at: "2026-10-04T15:56:14.269893+00:00",
    request_status: "CREATED",
    status: "INVOICE_CREATED",
    payment_preimage: null,
    receiver_identity_public_key: null,
    invoice: {
      payment_hash: "aa".repeat(32),
      created_at: "2026-10-04T15:56:14.269893+00:00",
      expires_at: "2026-10-04T16:01:14.269893+00:00",
    },
  });
  expect(page.entries[1]).toMatchObject({
    request_status: "SUCCEEDED",
    status: "TRANSFER_COMPLETED",
    payment_preimage: PREIMAGE,
    receiver_identity_public_key: RECEIVER,
  });
  // A field the SSP left out reads as null.
  expect(page.entries[2].status).toBeNull();
});

Deno.test("the last page has no cursor and says so", async () => {
  const page = await world({ list: () => json(listBody([unpaid()])) }).client.listLightningReceives();
  expect(page).toEqual({ entries: [page.entries[0]], hasNextPage: false, endCursor: null });
});

Deno.test("page size and cursor are sent, with a page size of at most 200", async () => {
  const w = world();
  await w.client.listLightningReceives();
  await w.client.listLightningReceives({ first: 50, after: "cursor-9" });
  await w.client.listLightningReceives({ first: 1000 });
  await w.client.listLightningReceives({ first: 0 });
  await w.client.listLightningReceives({ first: Number.NaN });
  const lists = w.calls.filter((call) => call.operationName === "ListLightningReceives").map((call) => call.variables);
  expect(lists.map((variables) => variables.first)).toEqual([100, 50, 200, 1, 100]);
  expect(lists.map((variables) => variables.after)).toEqual([undefined, "cursor-9", undefined, undefined, undefined]);
  expect(new Set(lists.map((variables) => JSON.stringify(variables.types)))).toEqual(new Set(['["LIGHTNING_RECEIVE"]']));
});

// ---- the real signer ----

Deno.test("the real SDK signer, offline, produces what the client turns into a valid DER signature", async () => {
  // The BIP-39 test mnemonic: a throwaway identity, no funds, no network.
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const getSigner = createBreezIdentitySigner({ mnemonic });
  const key = bytesToHex(Uint8Array.from((await (await getSigner()).getIdentityPublicKey()).bytes));
  expect(key).toMatch(/^0[23][0-9a-f]{64}$/);

  const w = world({
    client: { getSigner },
    challenge: (call) =>
      json({ data: { get_challenge: { protected_challenge: b64url(new Uint8Array([9, ...hexToBytes(call.variables.input.public_key), 9])) } } }),
  });
  await w.client.listLightningReceives();
  const [challenge, verify] = w.calls;
  expect(challenge.variables.input.public_key).toEqual(key);
  expect(verify.variables.input.identity_public_key).toEqual(key);
  const der = fromB64url(verify.variables.input.signature);
  // noble parses it strictly: a well-formed DER with r and s in range.
  const parsed = secp256k1.Signature.fromDER(bytesToHex(der));
  expect(parsed.toDERHex()).toEqual(bytesToHex(der));
});
