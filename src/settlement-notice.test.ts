import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import {
  createSettlementNotifier,
  isAppBookingInvoice,
  NOTICE_BACKOFF_MS,
  NOTICE_MAX_ATTEMPTS,
  NOTICE_PATH,
  resolveNoticeTarget,
  signSettlementNotice,
} from "./settlement-notice.ts";
import { captureLogs, entriesFor } from "./test_logs.ts";

const SECRET = "registration-secret-for-vector";
const HASH = "ab".repeat(32);
const BOOKING_DESCRIPTION = "Rafting in Mendoza - 3 people | travelsats.ar";
const ORIGIN = "https://travelsats.ar";

// Computed with `openssl dgst`, not with the code under test:
//   key       = HMAC-SHA256(SECRET, "settlement-notice-v1")  (hex 40332a71...d28e)
//   signature = hex(HMAC-SHA256(key, "1700000000." + body))
const VECTOR_BODY = `{"payment_hash":"${HASH}"}`;
const VECTOR_SIGNATURE = "8648c78accbe1a949aab2bbc1eb782d220e5c9dd486142b3688f3de10462fa8e";

const bookingInvoice = (over: Record<string, unknown> = {}) => ({
  paymentHash: HASH,
  description: BOOKING_DESCRIPTION,
  metadata: { comment: BOOKING_DESCRIPTION },
  ...over,
});

type Call = { url: string; init: RequestInit };

function harness(options: {
  secret?: string | undefined;
  origins?: readonly string[];
  answers?: Array<number | Error>;
  requestTimeoutMs?: number;
} = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const answers = [...(options.answers ?? [200])];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const answer = answers.shift() ?? 200;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(new Response("{}", { status: answer }));
  }) as typeof fetch;
  const notifier = createSettlementNotifier({
    secret: () => "secret" in options ? options.secret : SECRET,
    origins: options.origins ?? [ORIGIN],
    fetch: fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date(1_700_000_000_000),
    requestTimeoutMs: options.requestTimeoutMs,
  });
  return { notifier, calls, sleeps };
}

// ---- signature ----

Deno.test("the signature matches a vector computed independently with the documented construction", () => {
  expect(signSettlementNotice(SECRET, "1700000000", VECTOR_BODY)).toEqual(VECTOR_SIGNATURE);
});

Deno.test("the raw secret never signs: the signature differs from a plain HMAC under the secret", async () => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const plain = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`1700000000.${VECTOR_BODY}`)));
  const plainHex = Array.from(plain, (byte) => byte.toString(16).padStart(2, "0")).join("");
  expect(plainHex).not.toEqual(VECTOR_SIGNATURE);
});

// ---- target origin ----

Deno.test("the target is the first APP_ORIGINS entry that is an http(s) origin; none means no target", () => {
  expect(resolveNoticeTarget(["https://dev.travelsats.ar", "https://travelsats.ar"])).toEqual("https://dev.travelsats.ar");
  expect(resolveNoticeTarget(["not a url", "ftp://x.test", "https://travelsats.ar/some/path"])).toEqual("https://travelsats.ar");
  expect(resolveNoticeTarget([])).toBeNull();
  expect(resolveNoticeTarget(["", "garbage"])).toBeNull();
});

// ---- which invoices are reported ----

Deno.test("only an invoice carrying the app's booking description is an app booking invoice; zaps and tips are not", () => {
  expect(isAppBookingInvoice(bookingInvoice())).toBe(true);
  expect(isAppBookingInvoice({ description: null, metadata: { comment: BOOKING_DESCRIPTION } })).toBe(true);
  expect(isAppBookingInvoice({ description: BOOKING_DESCRIPTION, metadata: null })).toBe(true);
  // A tip or any other comment.
  expect(isAppBookingInvoice({ description: "thanks for the tour", metadata: { comment: "thanks for the tour" } })).toBe(false);
  expect(isAppBookingInvoice({ description: null, metadata: null })).toBe(false);
  // A zap is never reported, even if its content mimics the booking description.
  expect(isAppBookingInvoice(bookingInvoice({ metadata: { nostr: { kind: 9734 } } }))).toBe(false);
});

// ---- delivery ----

Deno.test("a booking invoice sends one signed POST with exactly the payment hash", async () => {
  const h = harness();
  expect(await h.notifier.notify(bookingInvoice())).toEqual("sent");
  expect(h.calls.length).toBe(1);
  const [{ url, init }] = h.calls;
  expect(url).toEqual(`${ORIGIN}${NOTICE_PATH}`);
  expect(NOTICE_PATH).toEqual("/api/lightning/settlement-notice");
  expect(init.method).toEqual("POST");
  expect(init.body).toEqual(VECTOR_BODY);
  const headers = new Headers(init.headers);
  expect(headers.get("X-Travelsats-Timestamp")).toEqual("1700000000");
  expect(headers.get("X-Travelsats-Signature")).toEqual(VECTOR_SIGNATURE);
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(h.sleeps).toEqual([]);
});

Deno.test("the payment hash is sent lowercase and an invalid one sends nothing", async () => {
  const h = harness();
  await h.notifier.notify(bookingInvoice({ paymentHash: HASH.toUpperCase() }));
  expect(h.calls[0].init.body).toEqual(VECTOR_BODY);
  expect(await h.notifier.notify(bookingInvoice({ paymentHash: "not-a-hash" }))).toEqual("skipped");
  expect(h.calls.length).toBe(1);
});

Deno.test("a missing or blank secret sends nothing", async () => {
  for (const secret of [undefined, "", "   "]) {
    const h = harness({ secret });
    expect(await h.notifier.notify(bookingInvoice())).toEqual("skipped");
    expect(h.calls).toEqual([]);
  }
});

Deno.test("no configured origin sends nothing", async () => {
  const h = harness({ origins: [] });
  expect(await h.notifier.notify(bookingInvoice())).toEqual("skipped");
  expect(h.calls).toEqual([]);
});

Deno.test("an invoice the app did not mint for a booking sends nothing", async () => {
  const h = harness();
  expect(await h.notifier.notify({ paymentHash: HASH, description: "tip", metadata: { comment: "tip" } })).toEqual("skipped");
  expect(await h.notifier.notify(bookingInvoice({ metadata: { nostr: {} } }))).toEqual("skipped");
  expect(h.calls).toEqual([]);
});

Deno.test("a 5xx or a network error is retried in place up to the bound, with short backoff, then gives up with one log line", async () => {
  const h = harness({ answers: [503, new TypeError("connection refused"), 502, 200] });
  const { result, entries, raw } = await captureLogs(() => h.notifier.notify(bookingInvoice()));
  expect(result).toEqual("failed");
  expect(NOTICE_MAX_ATTEMPTS).toBe(3);
  expect(h.calls.length).toBe(NOTICE_MAX_ATTEMPTS);
  expect(h.sleeps).toEqual(NOTICE_BACKOFF_MS);
  expect(h.sleeps.length).toBe(NOTICE_MAX_ATTEMPTS - 1);
  const failed = entriesFor(entries, "settlement_notice_failed");
  expect(failed.length).toBe(1);
  expect(failed[0].args?.payment_hash).toEqual(HASH);
  expect(failed[0].args?.attempts).toBe(3);
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain(VECTOR_SIGNATURE);
});

Deno.test("the whole retry budget stays well under ten seconds", async () => {
  const { NOTICE_REQUEST_TIMEOUT_MS } = await import("./settlement-notice.ts");
  const worst = NOTICE_MAX_ATTEMPTS * NOTICE_REQUEST_TIMEOUT_MS + NOTICE_BACKOFF_MS.reduce((a, b) => a + b, 0);
  expect(worst).toBeLessThan(10_000);
});

Deno.test("a retry that succeeds stops retrying and logs one success line", async () => {
  const h = harness({ answers: [500, 200] });
  const { result, entries } = await captureLogs(() => h.notifier.notify(bookingInvoice()));
  expect(result).toEqual("sent");
  expect(h.calls.length).toBe(2);
  expect(entriesFor(entries, "settlement_notice_sent").length).toBe(1);
  expect(entriesFor(entries, "settlement_notice_failed").length).toBe(0);
});

Deno.test("a 4xx is final: it is not retried", async () => {
  const h = harness({ answers: [401, 200] });
  const { result, entries } = await captureLogs(() => h.notifier.notify(bookingInvoice()));
  expect(result).toEqual("failed");
  expect(h.calls.length).toBe(1);
  expect(entriesFor(entries, "settlement_notice_failed").length).toBe(1);
});

Deno.test("every attempt is signed afresh with the clock at that attempt", async () => {
  const h = harness({ answers: [500, 200] });
  await h.notifier.notify(bookingInvoice());
  for (const { init } of h.calls) {
    expect(new Headers(init.headers).get("X-Travelsats-Signature")).toEqual(VECTOR_SIGNATURE);
  }
});

Deno.test("a request that never answers is aborted by its own timeout", async () => {
  const calls: AbortSignal[] = [];
  const notifier = createSettlementNotifier({
    secret: () => SECRET,
    origins: [ORIGIN],
    fetch: ((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      calls.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch,
    sleep: async () => {},
    requestTimeoutMs: 5,
  });
  const { entries } = await captureLogs(() => notifier.notify(bookingInvoice()));
  expect(calls.length).toBe(NOTICE_MAX_ATTEMPTS);
  expect(calls.every((signal) => signal.aborted)).toBe(true);
  expect(entriesFor(entries, "settlement_notice_failed").length).toBe(1);
});

Deno.test("notify never throws, whatever the transport or the sleeper does", async () => {
  const throwing = createSettlementNotifier({
    secret: () => SECRET,
    origins: [ORIGIN],
    fetch: (() => {
      throw new Error("synchronous failure");
    }) as unknown as typeof fetch,
    sleep: async () => {
      throw new Error("sleep failed");
    },
  });
  const { result } = await captureLogs(() => throwing.notify(bookingInvoice()));
  expect(result).toEqual("failed");

  const badSecret = createSettlementNotifier({
    secret: () => {
      throw new Error("env unavailable");
    },
    origins: [ORIGIN],
    fetch: (() => Promise.resolve(new Response("{}"))) as typeof fetch,
  });
  expect(await badSecret.notify(bookingInvoice())).toEqual("skipped");
});
