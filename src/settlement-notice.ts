import { createHmac } from "node:crypto";
import { logger } from "./logger.ts";

/**
 * The settlement notice: the signed cue Lite sends the Travelsats app the first time it records an
 * app-minted booking invoice as settled, so a payment is noticed with the app closed.
 *
 * A notice is a cue, never a proof. The app re-verifies through Lite's own verify endpoint (LUD-21
 * plus the preimage check), so the notice carries only the payment hash and decides nothing.
 *
 * Wire format (mirrors the app's `lib/lightning/settlement-notice.ts`):
 *   POST <app origin>/api/lightning/settlement-notice
 *   X-Travelsats-Timestamp: <unix seconds>
 *   X-Travelsats-Signature: <lowercase hex HMAC-SHA256 of "<timestamp>.<raw body>">
 *   body: {"payment_hash":"<64 lowercase hex>"} and nothing else
 *
 * No new secret: the key is derived from `TRAVELSATS_REGISTRATION_SECRET`, which Lite already reads.
 * The raw secret never signs:
 *   key       = HMAC-SHA256(secret, "settlement-notice-v1")
 *   signature = hex(HMAC-SHA256(key, "<timestamp>.<raw body>"))
 *
 * Optional, dev only: when `VERCEL_PROTECTION_BYPASS` is set, every request also carries
 * `x-vercel-protection-bypass: <value>` so it passes Vercel Deployment Protection. Unset or blank
 * (production), no such header is sent. The value is never logged.
 */

/** The derivation label of the signing key. The app mirrors it byte for byte. */
export const NOTICE_KEY_LABEL = "settlement-notice-v1";
export const NOTICE_PATH = "/api/lightning/settlement-notice";
const TIMESTAMP_HEADER = "X-Travelsats-Timestamp";
const SIGNATURE_HEADER = "X-Travelsats-Signature";
/** Vercel's "Protection Bypass for Automation" header. Dev only: the dev app sits behind Deployment Protection. */
const BYPASS_HEADER = "x-vercel-protection-bypass";

/** Attempts per notice: the first send plus two retries. */
export const NOTICE_MAX_ATTEMPTS = 3;
/** Waits between attempts, in milliseconds. One fewer than the attempts. */
export const NOTICE_BACKOFF_MS: readonly number[] = [250, 500];
/** Deadline of each request. Worst case: 3 x 2 s + 0.75 s of backoff, well under 10 s. */
export const NOTICE_REQUEST_TIMEOUT_MS = 2_000;

/**
 * How Lite recognizes an invoice the app minted for a booking. Lite's `minted_by` column records the
 * wallet kind (`nwc` or `spark`), not the caller, and the app mints through the public LNURL-pay
 * callback like any payer, so the only thing that marks a booking invoice is the description the app
 * sends as the callback `comment` (`formatInvoiceDescription`): "<title> - <guests> | travelsats.ar".
 * Lite stores it as the invoice's description and `metadata.comment`.
 *
 * A payer can type the same suffix. That is harmless by design: the notice only prompts the app to
 * re-verify, and the app answers the same for a hash that belongs to no booking.
 */
export const APP_BOOKING_DESCRIPTION_SUFFIX = " | travelsats.ar";

const PAYMENT_HASH = /^[0-9a-f]{64}$/i;

/** What the hook needs to know about the invoice that was just settled. */
export interface NoticeInvoice {
  paymentHash: string;
  description: string | null;
  metadata: unknown;
}

export type NoticeOutcome = "sent" | "failed" | "skipped";

function metadataField(metadata: unknown, key: string): unknown {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, unknown>)[key];
}

const carriesBookingDescription = (text: unknown): boolean =>
  typeof text === "string" && text.endsWith(APP_BOOKING_DESCRIPTION_SUFFIX);

/** True for an invoice the app minted for a booking. Zaps (a stored zap request) and tips never are. */
export function isAppBookingInvoice(invoice: Pick<NoticeInvoice, "description" | "metadata">): boolean {
  if (metadataField(invoice.metadata, "nostr") !== undefined && metadataField(invoice.metadata, "nostr") !== null) {
    return false;
  }
  return carriesBookingDescription(invoice.description) ||
    carriesBookingDescription(metadataField(invoice.metadata, "comment"));
}

/**
 * The origin notices go to: the first `APP_ORIGINS` entry that is an http(s) origin, in the order
 * listed, so the choice is deterministic. `APP_ORIGINS` defaults to the `BASE_URL` origin, which is
 * the app's own origin in production. Null when none qualifies: nothing is sent.
 */
export function resolveNoticeTarget(origins: readonly string[]): string | null {
  for (const candidate of origins) {
    try {
      const url = new URL(candidate.trim());
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // Not a URL: try the next entry.
    }
  }
  return null;
}

/** Lowercase hex HMAC-SHA256 of `<timestamp>.<rawBody>` under the key derived from `secret`. */
export function signSettlementNotice(secret: string, timestamp: string, rawBody: string): string {
  const key = new Uint8Array(createHmac("sha256", secret).update(NOTICE_KEY_LABEL).digest());
  return createHmac("sha256", key).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** The shared registration secret, or undefined when unset. Read at call time, like the registration check. */
function readRegistrationSecret(): string | undefined {
  return Deno.env.get("TRAVELSATS_REGISTRATION_SECRET");
}

/** The Vercel protection bypass secret, or undefined when unset. Read at call time. */
function readProtectionBypass(): string | undefined {
  return Deno.env.get("VERCEL_PROTECTION_BYPASS");
}

export interface SettlementNotifierDeps {
  /** App origins, in order (`APP_ORIGINS`). */
  origins: readonly string[];
  /** The shared secret. Defaults to `TRAVELSATS_REGISTRATION_SECRET`, read per notice. */
  secret?: () => string | null | undefined;
  /** Vercel Protection Bypass for Automation secret. Defaults to `VERCEL_PROTECTION_BYPASS`, read per notice. */
  protectionBypass?: () => string | null | undefined;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  requestTimeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `notify` delivers one notice and never throws or rejects. The caller does not await it: it runs
 * after the settlement write, with a few in-place retries on a network error, a timeout, a redirect or a 5xx,
 * then gives up with one log line. No queue and no persisted retry state: a notice that is lost is
 * recovered by the app's own read-time reconcile.
 */
export function createSettlementNotifier(deps: SettlementNotifierDeps) {
  const send = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.requestTimeoutMs ?? NOTICE_REQUEST_TIMEOUT_MS;
  const readSecret = deps.secret ?? readRegistrationSecret;
  const readBypass = deps.protectionBypass ?? readProtectionBypass;

  /**
   * One request. "retry" for a network error, a timeout, a redirect or a 5xx; "final" for a 4xx.
   * Redirects are never followed (`redirect: "manual"`): a 3xx is the app's login or protection wall,
   * so it is a failed attempt, never a delivery.
   */
  async function attempt(
    url: string,
    secret: string,
    bypass: string | undefined,
    rawBody: string,
  ): Promise<"ok" | "retry" | "final"> {
    const timestamp = String(Math.floor(now().getTime() / 1000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await send(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signSettlementNotice(secret, timestamp, rawBody),
          ...(bypass ? { [BYPASS_HEADER]: bypass } : {}),
        },
        body: rawBody,
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
      if (response.status >= 200 && response.status < 300) return "ok";
      return response.status >= 500 || (response.status >= 300 && response.status < 400) ? "retry" : "final";
    } catch {
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliver(invoice: NoticeInvoice): Promise<NoticeOutcome> {
    let secret: string | null | undefined;
    try {
      secret = readSecret();
    } catch {
      return "skipped";
    }
    if (!secret || secret.trim() === "") return "skipped";
    const target = resolveNoticeTarget(deps.origins);
    if (target === null) return "skipped";
    if (!isAppBookingInvoice(invoice)) return "skipped";
    if (!PAYMENT_HASH.test(invoice.paymentHash)) return "skipped";

    const paymentHash = invoice.paymentHash.toLowerCase();
    const rawBody = JSON.stringify({ payment_hash: paymentHash });
    const url = `${target}${NOTICE_PATH}`;
    let bypass: string | undefined;
    try {
      const value = readBypass();
      bypass = value && value.trim() !== "" ? value.trim() : undefined;
    } catch {
      bypass = undefined;
    }

    let attempts = 0;
    let verdict: "ok" | "retry" | "final" = "retry";
    while (attempts < NOTICE_MAX_ATTEMPTS && verdict === "retry") {
      if (attempts > 0) await sleep(NOTICE_BACKOFF_MS[attempts - 1] ?? 0);
      attempts += 1;
      verdict = await attempt(url, secret, bypass, rawBody);
    }

    if (verdict === "ok") {
      logger.info("settlement notice sent", { event: "settlement_notice_sent", payment_hash: paymentHash, attempts });
      return "sent";
    }
    logger.warn("settlement notice failed", { event: "settlement_notice_failed", payment_hash: paymentHash, attempts });
    return "failed";
  }

  return {
    async notify(invoice: NoticeInvoice): Promise<NoticeOutcome> {
      try {
        return await deliver(invoice);
      } catch {
        try {
          logger.warn("settlement notice failed", {
            event: "settlement_notice_failed",
            payment_hash: String(invoice?.paymentHash ?? ""),
          });
        } catch {
          // Logging must not throw into the settlement path either.
        }
        return "failed";
      }
    },
  };
}
