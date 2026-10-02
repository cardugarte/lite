import { expect } from "jsr:@std/expect";
import type { DB } from "../db/db.ts";

// constants.ts reads BASE_URL once at import time, so the dev value is set only
// around the dynamic imports and restored for every other test file.
const previousBaseUrl = Deno.env.get("BASE_URL");
Deno.env.set("BASE_URL", "https://lite-dev.travelsats.ar");
await import("../test_setup.ts");
const { createLnurlWellKnownApp } = await import("./lnurlp.ts");
if (previousBaseUrl === undefined) Deno.env.delete("BASE_URL");
else Deno.env.set("BASE_URL", previousBaseUrl);

const db = {
  findUser: async (username: string) => {
    if (username !== "alice") throw new Error("user not found");
    return { id: 1, username: "alice" };
  },
} as unknown as DB;

Deno.test("the LNURL-pay response advertises the LNURL domain and keeps BASE_URL for the callback", async () => {
  const app = createLnurlWellKnownApp(db);
  const res = await app.request("/alice");
  expect(res.status).toEqual(200);
  const body = await res.json();
  expect(body.tag).toEqual("payRequest");
  expect(body.callback).toEqual("https://lite-dev.travelsats.ar/lnurlp/alice/callback");
  expect(JSON.parse(body.metadata)).toEqual([
    ["text/identifier", "alice@lite-dev.travelsats.ar"],
    ["text/plain", "Sats for alice"],
  ]);
});

Deno.test("an unknown user is an LNURL error, not a pay request", async () => {
  const app = createLnurlWellKnownApp(db);
  const res = await app.request("/nobody");
  const body = await res.json();
  expect(body.status).toEqual("ERROR");
  expect(body.tag).toBeUndefined();
});
