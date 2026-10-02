import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import * as nodeCrypto from "node:crypto";
import { Hono } from "hono";
import {
  readAssertedNostrPubkey,
  registrationCrypto,
  requireRegistrationSecret,
} from "./bff.ts";

const SECRET = "s3cret";
const NPUB = "ab".repeat(32);

function app() {
  const hono = new Hono();
  hono.post("/check", (c) => {
    const denied = requireRegistrationSecret(c);
    if (denied) return denied;
    const asserted = readAssertedNostrPubkey(c);
    if (!asserted.ok) return asserted.response;
    return c.json({ pubkey: asserted.pubkey });
  });
  return hono;
}

async function withSecret<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
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

function post(
  headers: Record<string, string> = {},
  body = "{}",
) {
  return app().request("/check", { method: "POST", headers, body });
}

Deno.test("wrong secret of equal length is rejected", async () => {
  await withSecret(SECRET, async () => {
    const res = await post({ "X-Travelsats-Registration": "s3creX" });
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
  });
});

Deno.test("wrong secret of different length is rejected", async () => {
  await withSecret(SECRET, async () => {
    const res = await post({ "X-Travelsats-Registration": "s3cret-and-more" });
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
  });
});

Deno.test("unset, empty, and whitespace-only secret is 503 for every header", async () => {
  const headerSets: Array<Record<string, string>> = [
    {},
    { "X-Travelsats-Registration": "" },
    { "X-Travelsats-Registration": "anything" },
  ];
  for (const secret of [undefined, "", "   ", "\t\n"]) {
    await withSecret(secret, async () => {
      for (const headers of headerSets) {
        const res = await post(headers);
        expect(res.status).toEqual(503);
        expect(await res.json()).toEqual({
          status: "ERROR",
          reason: "registration credential not configured",
        });
      }
    });
  }
});

Deno.test("registration secret is read from the environment on every request", async () => {
  await withSecret(undefined, async () => {
    const unset = await post({ "X-Travelsats-Registration": SECRET });
    expect(unset.status).toEqual(503);
  });
  await withSecret(SECRET, async () => {
    const configured = await post({ "X-Travelsats-Registration": "nope" });
    expect(configured.status).toEqual(403);
  });
});

Deno.test("timingSafeEqual runs once for equal length and never on a length mismatch", async () => {
  expect(registrationCrypto.timingSafeEqual).toBe(nodeCrypto.timingSafeEqual);
  const calls: Array<{ left: number; right: number }> = [];
  registrationCrypto.timingSafeEqual = (
    left: NodeJS.ArrayBufferView,
    right: NodeJS.ArrayBufferView,
  ) => {
    calls.push({ left: left.byteLength, right: right.byteLength });
    return nodeCrypto.timingSafeEqual(left, right);
  };
  try {
    await withSecret(SECRET, async () => {
      const equalLength = await post({ "X-Travelsats-Registration": "s3creX" });
      expect(equalLength.status).toEqual(403);
      const differentLength = await post({
        "X-Travelsats-Registration": "s3cret-and-more",
      });
      expect(differentLength.status).toEqual(403);
    });
  } finally {
    registrationCrypto.timingSafeEqual = nodeCrypto.timingSafeEqual;
  }
  expect(calls).toEqual([{ left: SECRET.length, right: SECRET.length }]);
});

Deno.test("Authorization Bearer alone does not authorize", async () => {
  await withSecret(SECRET, async () => {
    const res = await post({ Authorization: `Bearer ${SECRET}` });
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
  });
});

Deno.test("npub header absent, short, or non-hex is 400", async () => {
  await withSecret(SECRET, async () => {
    const headers = { "X-Travelsats-Registration": SECRET };
    const absent = await post(headers);
    const short = await post({
      ...headers,
      "X-Travelsats-Nostr-Pubkey": "a".repeat(63),
    });
    const nonHex = await post({
      ...headers,
      "X-Travelsats-Nostr-Pubkey": "g".repeat(64),
    });
    for (const res of [absent, short, nonHex]) {
      expect(res.status).toEqual(400);
      expect(await res.json()).toEqual({
        status: "ERROR",
        reason: "missing or invalid npub assertion",
      });
    }
  });
});

Deno.test("uppercase 64-hex npub header normalizes to lowercase", async () => {
  await withSecret(SECRET, async () => {
    const res = await post({
      "X-Travelsats-Registration": SECRET,
      "X-Travelsats-Nostr-Pubkey": NPUB.toUpperCase(),
    });
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ pubkey: NPUB });
  });
});

Deno.test("npub header is not read when the secret fails", async () => {
  await withSecret(SECRET, async () => {
    const res = await post({
      "X-Travelsats-Registration": "s3creX",
      "X-Travelsats-Nostr-Pubkey": "not-hex",
    });
    expect(res.status).toEqual(403);
    expect(await res.json()).toEqual({ status: "ERROR", reason: "forbidden" });
  });
});
