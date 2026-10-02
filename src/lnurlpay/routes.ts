import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "../logger.ts";
import { normalizeUsername, usernameProblem } from "../db/userValues.ts";
import { createLnurlpayService } from "./service.ts";
import type { LnurlpayDeps, Reply } from "./service.ts";
import * as signedMessage from "./signedMessage.ts";
import { isFresh, parseDerSignature, parsePubkey, verifySignedMessage } from "./verify.ts";

export const PAYLOAD_TOO_LARGE = "payload too large";

const MAX_DESCRIPTION_CODE_POINTS = 255;
const COMPRESSED_PUBKEY = /^0[23][0-9a-fA-F]{64}$/;

type Verified = {
  pubkey: string;
  username: string;
  timestamp: number;
  message: string;
};

type Spec = {
  needsUsername: boolean;
  needsDescription: boolean;
  message: (input: { domain: string; pubkey: string; username: string; description: string; timestamp: number }) => string;
};

const SPECS = {
  register: {
    needsUsername: true,
    needsDescription: true,
    message: (i) => signedMessage.register(i.domain, i.username, i.description, i.timestamp),
  },
  unregister: {
    needsUsername: true,
    needsDescription: false,
    message: (i) => signedMessage.unregister(i.domain, i.username, i.timestamp),
  },
  recover: {
    needsUsername: false,
    needsDescription: false,
    message: (i) => signedMessage.recover(i.domain, i.pubkey, i.timestamp),
  },
  available: {
    needsUsername: true,
    needsDescription: false,
    message: (i) => signedMessage.available(i.domain, i.pubkey, i.username, i.timestamp),
  },
} satisfies Record<string, Spec>;

/** Every error body is a JSON string; the SDK shows it verbatim. */
const fail = (c: Context, status: 400 | 404 | 413 | 500, reason: string) => c.json(reason, status);

const reply = (c: Context, answer: Reply) => c.json(answer.body, answer.status);

/**
 * The public breez-lnurl v2 management surface. Never answers 401 (the SDK
 * maps it to "Invalid api key"), never reads `Authorization`, and verifies the
 * signature before any database access.
 */
export function createLnurlpayApp(deps: LnurlpayDeps) {
  const service = createLnurlpayService(deps);
  const hono = new Hono();

  /** Checks 2 to 8 in order. The first failure is the response. */
  async function check(c: Context, spec: Spec): Promise<Verified | Response> {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (error) {
      // A malformed document is a bad request; anything else (the body-limit
      // middleware erroring a chunked stream) belongs to the error handler.
      if (error instanceof SyntaxError) return fail(c, 400, "invalid request");
      throw error;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return fail(c, 400, "invalid request");
    }
    const fields = body as Record<string, unknown>;
    const { signature, timestamp, username: rawUsername, description } = fields;
    if (
      typeof signature !== "string" ||
      typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      (spec.needsUsername && typeof rawUsername !== "string")
    ) {
      return fail(c, 400, "invalid request");
    }

    let username = "";
    if (spec.needsUsername) {
      username = normalizeUsername(rawUsername as string);
      const problem = usernameProblem(username);
      if (problem) return fail(c, 400, problem === "too_long" ? "username too long" : "invalid username");
    }
    if (spec.needsDescription) {
      if (typeof description !== "string") return fail(c, 400, "description required");
      if ([...description].length > MAX_DESCRIPTION_CODE_POINTS) {
        return fail(c, 400, "description too long");
      }
    }

    const pubkey = parsePubkey(c.req.param("pubkey") ?? "");
    if (!pubkey) return fail(c, 400, "invalid pubkey");
    if (!parseDerSignature(signature)) return fail(c, 400, "invalid signature");
    if (!isFresh(timestamp, deps.now().getTime())) return fail(c, 400, "invalid timestamp");

    const message = spec.message({
      domain: deps.domain,
      pubkey,
      username,
      description: typeof description === "string" ? description : "",
      timestamp,
    });
    if (!verifySignedMessage(pubkey, signature, message)) {
      return fail(c, 400, `invalid signature for domain '${deps.domain}'`);
    }
    return { pubkey, username, timestamp, message };
  }

  hono.post("/:pubkey", async (c) => {
    const verified = await check(c, SPECS.register);
    if (verified instanceof Response) return verified;
    return reply(c, await service.register(verified));
  });

  hono.delete("/:pubkey", async (c) => {
    const verified = await check(c, SPECS.unregister);
    if (verified instanceof Response) return verified;
    return reply(c, await service.unregister(verified));
  });

  hono.post("/:pubkey/recover", async (c) => {
    const verified = await check(c, SPECS.recover);
    if (verified instanceof Response) return verified;
    return reply(c, await service.recover(verified));
  });

  hono.post("/:pubkey/available", async (c) => {
    const verified = await check(c, SPECS.available);
    if (verified instanceof Response) return verified;
    return reply(c, await service.available(verified));
  });

  // No signature and no database: the SDK sync loop only needs a clean empty page.
  hono.get("/:pubkey/metadata", (c) => {
    if (!COMPRESSED_PUBKEY.test(c.req.param("pubkey"))) return fail(c, 400, "invalid pubkey");
    c.header("Cache-Control", "no-store, private");
    return c.json({ metadata: [] });
  });

  hono.notFound((c) => fail(c, 404, "not found"));
  hono.onError((error, c) => {
    // The body-limit middleware errors a chunked body that passes the cap.
    if (error.name === "BodyLimitError") return fail(c, 413, PAYLOAD_TOO_LARGE);
    logger.error("lnurlpay request failed", { errorName: error instanceof Error ? error.name : "Error" });
    return fail(c, 500, "internal error");
  });

  return hono;
}
