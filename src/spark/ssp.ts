/**
 * A client for the Spark Service Provider's GraphQL API (Lightspark), the
 * service Breez's Spark SDK talks to. Lite uses it for one thing: to read the
 * lightning receive requests the minter identity created, so it can tell
 * whether an invoice was paid when the webhook never arrived (ADR 0014).
 *
 * It authenticates as the minter's own Spark identity: `get_challenge`, a
 * signature from the SDK's signer handle (the compact signature becomes DER),
 * then `verify_challenge`. The session lasts about 600 seconds and is cached.
 * No Breez API key is involved. The API is not documented: the field names and
 * the authentication flow were observed on mainnet on 2026-10-04.
 *
 * This client reads. The GraphQL mutations in this file are the two
 * authentication steps and nothing else, so it cannot move funds. It never
 * logs, and an error message never carries a token, a challenge or a signature.
 */
import { bytesToHex } from "npm:@noble/hashes@1.3.1/utils";

/** The endpoint and schema version the authentication flow was observed on. */
export const SSP_GRAPHQL_URL = "https://api.lightspark.com/graphql/spark/2025-03-19";
/** The most records one list call can ask for. */
export const SSP_MAX_PAGE_SIZE = 200;

const DEFAULT_PAGE_SIZE = 100;
/** Generous on purpose: a slow answer that finishes is better than a fast one that keeps timing out. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** A session is renewed this long before its `valid_until`. */
const SESSION_MARGIN_MS = 60_000;
/** The compressed secp256k1 key of a Spark identity. */
const IDENTITY_KEY_BYTES = 33;

const GET_CHALLENGE =
  "mutation GetChallenge($input: GetChallengeInput!) { get_challenge(input: $input) { protected_challenge } }";
const VERIFY_CHALLENGE =
  "mutation VerifyChallenge($input: VerifyChallengeInput!) { verify_challenge(input: $input) { valid_until session_token } }";
const LIST_LIGHTNING_RECEIVES = `query ListLightningReceives($first: Int, $after: String, $types: [SparkUserRequestType!]) {
  current_user {
    ... on SparkWalletUser {
      user_requests(first: $first, after: $after, types: $types) {
        page_info { has_next_page end_cursor }
        entities {
          __typename
          ... on LightningReceiveRequest {
            id created_at updated_at request_status status
            payment_preimage receiver_identity_public_key
            invoice { payment_hash created_at expires_at }
          }
        }
      }
    }
  }
}`;

/** What the SSP session needs from the Spark identity: its key, and a signature over the challenge. */
export type SparkIdentitySigner = {
  getIdentityPublicKey(): Promise<{ bytes: ArrayLike<number> }>;
  signAuthenticationChallenge(challenge: Uint8Array): Promise<{ bytes: ArrayLike<number> }>;
};

/** A lightning receive request, with the field names the SSP uses. A field the SSP left out reads as null. */
export type SspLightningReceive = {
  id: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** `CREATED` while unpaid, `SUCCEEDED` once paid. */
  request_status: string | null;
  /** `INVOICE_CREATED` while unpaid, `TRANSFER_COMPLETED` once the receiver is credited. */
  status: string | null;
  /** Present only after payment. */
  payment_preimage: string | null;
  receiver_identity_public_key: string | null;
  invoice: { payment_hash: string; created_at: string | null; expires_at: string | null };
};

export type SspPage = {
  /** Newest first. Only receive requests that carry an invoice. */
  entries: SspLightningReceive[];
  hasNextPage: boolean;
  endCursor: string | null;
};

export type SspClient = {
  /** One page of the minter's lightning receive requests, newest first. */
  listLightningReceives(args?: { first?: number; after?: string }): Promise<SspPage>;
};

export type SspErrorKind =
  /** The SSP could not be reached, or did not answer in time. */
  | "network"
  /** A non-2xx answer other than a refused session. */
  | "http"
  /** HTTP 200 with GraphQL errors. */
  | "graphql"
  /** The session was refused, or the challenge could not be trusted. */
  | "auth"
  /** The answer is not what this client expects. */
  | "shape";

export class SspError extends Error {
  override name = "SspError";
  constructor(message: string, readonly kind: SspErrorKind, readonly status?: number) {
    super(message);
  }
}

const AUTH_ERROR =
  /unauthenticated|unauthorized|not authenticated|authentication (failed|required)|invalid (session|token|credentials)|(session|token|jwt) (is )?(expired|invalid)|expired (session|token)/i;

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return false;
  search: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue search;
    }
    return true;
  }
  return false;
}

/** A big-endian unsigned integer as a DER INTEGER: no leading zeros, one zero byte in front when the high bit is set. */
function derInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  const body = trimmed[0] & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
  return Uint8Array.of(0x02, body.length, ...body);
}

/** The signer handle returns the 64-byte compact form (r then s); the SSP takes DER. */
function derSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) {
    const r = derInteger(signature.subarray(0, 32));
    const s = derInteger(signature.subarray(32, 64));
    return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
  }
  // Already DER: a sequence of 68 to 72 bytes.
  if (signature.length >= 68 && signature.length <= 72 && signature[0] === 0x30) return signature;
  throw new SspError(`the signer returned ${signature.length} bytes, neither a compact nor a DER signature`, "shape");
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function readRecord(entity: unknown): SspLightningReceive[] {
  if (typeof entity !== "object" || entity === null) return [];
  const record = entity as Record<string, unknown>;
  const invoice = record.invoice as Record<string, unknown> | null | undefined;
  const paymentHash = invoice?.payment_hash;
  if (typeof paymentHash !== "string" || paymentHash === "") return [];
  return [{
    id: text(record.id),
    created_at: text(record.created_at),
    updated_at: text(record.updated_at),
    request_status: text(record.request_status),
    status: text(record.status),
    payment_preimage: text(record.payment_preimage),
    receiver_identity_public_key: text(record.receiver_identity_public_key),
    invoice: {
      payment_hash: paymentHash,
      created_at: text(invoice?.created_at),
      expires_at: text(invoice?.expires_at),
    },
  }];
}

function readPage(data: Record<string, unknown>): SspPage {
  const currentUser = data.current_user as { user_requests?: unknown } | null | undefined;
  const requests = currentUser?.user_requests as { page_info?: unknown; entities?: unknown } | null | undefined;
  if (typeof requests !== "object" || requests === null) {
    throw new SspError("SSP answered without user_requests", "shape");
  }
  const pageInfo = requests.page_info as { has_next_page?: unknown; end_cursor?: unknown } | null | undefined;
  if (typeof pageInfo !== "object" || pageInfo === null || typeof pageInfo.has_next_page !== "boolean") {
    throw new SspError("SSP answered without page_info", "shape");
  }
  if (!Array.isArray(requests.entities)) throw new SspError("SSP answered without entities", "shape");
  return {
    entries: requests.entities.flatMap(readRecord),
    hasNextPage: pageInfo.has_next_page,
    endCursor: text(pageInfo.end_cursor),
  };
}

export function createSspClient(opts: {
  getSigner: () => Promise<SparkIdentitySigner>;
  fetch?: typeof fetch;
  url?: string;
  /** Milliseconds, for the session cache. */
  now?: () => number;
  /** Per request. */
  timeoutMs?: number;
}): SspClient {
  const send = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const url = opts.url ?? SSP_GRAPHQL_URL;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  type Session = { token: string; validUntilMs: number };
  let session: Session | null = null;
  let authenticating: Promise<Session> | null = null;

  // What an error message must never carry: the latest tokens, challenges and signatures.
  const secrets: string[] = [];
  const remember = (secret: string) => {
    secrets.push(secret);
    if (secrets.length > 12) secrets.shift();
  };
  const redact = (message: string) =>
    secrets.reduce((clean, secret) => secret ? clean.split(secret).join("[redacted]") : clean, message);

  function graphqlError(errors: unknown[]): SspError {
    const first = (errors[0] ?? {}) as { message?: unknown; extensions?: { code?: unknown } };
    const detail = `${text(first.extensions?.code) ?? ""} ${text(first.message) ?? ""}`.trim();
    const kind: SspErrorKind = AUTH_ERROR.test(detail) ? "auth" : "graphql";
    const shown = redact(detail).slice(0, 300);
    return new SspError(`SSP GraphQL error${shown ? `: ${shown}` : ""}`, kind);
  }

  async function post(
    operationName: string,
    query: string,
    variables: unknown,
    token: string | null,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let body: string;
    try {
      const response = await send(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "travelsats-alby-lite",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ operationName, query, variables }),
        signal: controller.signal,
      });
      status = response.status;
      body = await response.text();
    } catch {
      throw new SspError(controller.signal.aborted ? "SSP request timed out" : "SSP request failed", "network");
    } finally {
      clearTimeout(timer);
    }

    if (status === 401 || status === 403) throw new SspError(`SSP refused the session (HTTP ${status})`, "auth", status);
    if (status < 200 || status >= 300) throw new SspError(`SSP answered HTTP ${status}`, "http", status);
    let parsed: { data?: unknown; errors?: unknown } | null;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new SspError("SSP answered with something that is not JSON", "shape");
    }
    if (typeof parsed !== "object" || parsed === null) throw new SspError("SSP answered with an unexpected body", "shape");
    // An HTTP 200 can still be a failure: GraphQL reports errors in the body, possibly next to partial data.
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) throw graphqlError(parsed.errors);
    if (typeof parsed.data !== "object" || parsed.data === null) throw new SspError("SSP answered without data", "shape");
    return parsed.data as Record<string, unknown>;
  }

  async function authenticateOnce(): Promise<Session> {
    const signer = await opts.getSigner();
    const identity = Uint8Array.from((await signer.getIdentityPublicKey()).bytes);
    if (identity.length !== IDENTITY_KEY_BYTES) {
      throw new SspError(`the signer's identity key is ${identity.length} bytes, not ${IDENTITY_KEY_BYTES}`, "shape");
    }
    const identityHex = bytesToHex(identity);

    const issued = await post("GetChallenge", GET_CHALLENGE, { input: { public_key: identityHex } }, null);
    const protectedChallenge = (issued.get_challenge as { protected_challenge?: unknown } | null | undefined)
      ?.protected_challenge;
    if (typeof protectedChallenge !== "string" || protectedChallenge === "") {
      throw new SspError("SSP issued no challenge", "shape");
    }
    remember(protectedChallenge);
    let challenge: Uint8Array;
    try {
      challenge = fromBase64Url(protectedChallenge);
    } catch {
      throw new SspError("SSP issued a challenge that is not base64url", "shape");
    }
    // The check Breez's own client makes: never sign a challenge that does not name our key.
    if (!containsBytes(challenge, identity)) {
      throw new SspError("SSP challenge does not name the minter identity key; not signing it", "auth");
    }

    const signed = Uint8Array.from((await signer.signAuthenticationChallenge(challenge)).bytes);
    const signature = toBase64Url(derSignature(signed));
    remember(signature);

    const verified = await post(
      "VerifyChallenge",
      VERIFY_CHALLENGE,
      { input: { protected_challenge: protectedChallenge, signature, identity_public_key: identityHex } },
      null,
    );
    const result = verified.verify_challenge as { valid_until?: unknown; session_token?: unknown } | null | undefined;
    const token = result?.session_token;
    const validUntilMs = typeof result?.valid_until === "string" ? Date.parse(result.valid_until) : NaN;
    if (typeof token !== "string" || token === "" || Number.isNaN(validUntilMs)) {
      throw new SspError("SSP issued no usable session", "shape");
    }
    remember(token);
    return { token, validUntilMs };
  }

  /** One authentication at a time: callers that arrive while it runs share its outcome. */
  function startSession(): Promise<Session> {
    authenticating ??= authenticateOnce()
      .then((created) => {
        session = created;
        return created;
      })
      .finally(() => {
        authenticating = null;
      });
    return authenticating;
  }

  async function sessionToken(): Promise<string> {
    if (session && now() < session.validUntilMs - SESSION_MARGIN_MS) return session.token;
    return (await startSession()).token;
  }

  async function authenticated(
    operationName: string,
    query: string,
    variables: unknown,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0;; attempt++) {
      const bearer = await sessionToken();
      try {
        return await post(operationName, query, variables, bearer);
      } catch (error) {
        // A refused session is renewed once; a second refusal is the answer.
        if (attempt === 0 && error instanceof SspError && error.kind === "auth") {
          if (session?.token === bearer) session = null;
          continue;
        }
        throw error;
      }
    }
  }

  return {
    async listLightningReceives({ first, after } = {}) {
      const pageSize = first !== undefined && Number.isFinite(first)
        ? Math.min(Math.max(Math.trunc(first), 1), SSP_MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;
      const data = await authenticated("ListLightningReceives", LIST_LIGHTNING_RECEIVES, {
        first: pageSize,
        after,
        types: ["LIGHTNING_RECEIVE"],
      });
      return readPage(data);
    },
  };
}
