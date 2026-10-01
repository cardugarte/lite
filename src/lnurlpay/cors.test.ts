import { expect } from "jsr:@std/expect";
import { Hono } from "hono";
import { createLnurlpayCors } from "./cors.ts";

const PUBKEY = "02" + "ab".repeat(32);
const APP_ORIGIN = "https://dev.travelsats.ar";

function app(origins: string[]) {
  const hono = new Hono();
  hono.use("/lnurlpay/*", createLnurlpayCors(origins));
  hono.all("/lnurlpay/*", (c) => c.json("ok"));
  return hono;
}

function preflight(origins: string[], path: string, origin: string, method: string, headers: string) {
  return app(origins).request(path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": headers,
    },
  });
}

Deno.test("a write-route preflight from the app origin allows POST, DELETE, Authorization, and User-Agent only", async () => {
  const res = await preflight(
    [APP_ORIGIN],
    `/lnurlpay/${PUBKEY}`,
    APP_ORIGIN,
    "POST",
    "content-type,authorization,user-agent",
  );
  expect(res.status).toEqual(204);
  expect(res.headers.get("Access-Control-Allow-Origin")).toEqual(APP_ORIGIN);
  const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
  expect(methods).toContain("POST");
  expect(methods).toContain("DELETE");
  const headers = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
  expect(headers).toContain("authorization");
  expect(headers).toContain("user-agent");
  expect(headers).not.toContain("x-breez-signature");
  expect(headers).not.toContain("x-breez-timestamp");
  expect(res.headers.get("Access-Control-Max-Age")).toEqual("600");
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
});

Deno.test("the metadata preflight lists both X-Breez headers, and only the metadata route does", async () => {
  const metadata = await preflight(
    [APP_ORIGIN],
    `/lnurlpay/${PUBKEY}/metadata`,
    APP_ORIGIN,
    "GET",
    "x-breez-signature,x-breez-timestamp",
  );
  expect(metadata.status).toEqual(204);
  expect(metadata.headers.get("Access-Control-Allow-Origin")).toEqual(APP_ORIGIN);
  const headers = (metadata.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
  expect(headers).toContain("x-breez-signature");
  expect(headers).toContain("x-breez-timestamp");
  expect(headers).toContain("authorization");
  expect(headers).toContain("user-agent");
  expect(metadata.headers.get("Access-Control-Allow-Credentials")).toBeNull();

  for (const suffix of ["", "/recover", "/available", "/transfer", "/metadata/extra"]) {
    const res = await preflight([APP_ORIGIN], `/lnurlpay/${PUBKEY}${suffix}`, APP_ORIGIN, "POST", "content-type");
    const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
    expect({ suffix, breez: allowed.includes("x-breez") }).toEqual({ suffix, breez: false });
  }
});

Deno.test("an actual request from a listed origin carries the allow-origin header", async () => {
  for (const path of [`/lnurlpay/${PUBKEY}/recover`, `/lnurlpay/${PUBKEY}`, `/lnurlpay/${PUBKEY}/metadata`]) {
    const res = await app([APP_ORIGIN]).request(path, {
      method: path.endsWith("/metadata") ? "GET" : "POST",
      headers: { Origin: APP_ORIGIN },
    });
    expect(res.status).toEqual(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toEqual(APP_ORIGIN);
  }
});

Deno.test("a foreign origin never gets an allow-origin header, on requests or preflights", async () => {
  const origins = [APP_ORIGIN, "https://other.example"];
  const request = await app(origins).request(`/lnurlpay/${PUBKEY}/recover`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  });
  expect(request.status).toEqual(200);
  expect(request.headers.get("Access-Control-Allow-Origin")).toBeNull();
  for (const path of [`/lnurlpay/${PUBKEY}`, `/lnurlpay/${PUBKEY}/metadata`]) {
    const res = await preflight(origins, path, "https://evil.example", "POST", "content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  }
  const noOrigin = await app(origins).request(`/lnurlpay/${PUBKEY}/recover`, { method: "POST" });
  expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

Deno.test("every listed origin is echoed back as itself", async () => {
  const origins = ["https://a.example", "https://b.example"];
  for (const origin of origins) {
    const res = await preflight(origins, `/lnurlpay/${PUBKEY}`, origin, "POST", "content-type");
    expect(res.headers.get("Access-Control-Allow-Origin")).toEqual(origin);
  }
});
