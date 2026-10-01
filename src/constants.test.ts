import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import { DOMAIN, lnurlDomainFromBaseUrl, LNURL_DOMAIN, parseAppOrigins } from "./constants.ts";

Deno.test("lnurlDomainFromBaseUrl lowercases the host", () => {
  expect(lnurlDomainFromBaseUrl("https://Lite-Dev.TravelSats.AR")).toBe("lite-dev.travelsats.ar");
});

Deno.test("lnurlDomainFromBaseUrl drops a default port and keeps a non-default one", () => {
  expect(lnurlDomainFromBaseUrl("https://travelsats.ar:443")).toBe("travelsats.ar");
  expect(lnurlDomainFromBaseUrl("http://localhost:3000")).toBe("localhost:3000");
  expect(lnurlDomainFromBaseUrl("http://lnaddr.test")).toBe("lnaddr.test");
});

Deno.test("lnurlDomainFromBaseUrl ignores a path and a trailing slash", () => {
  expect(lnurlDomainFromBaseUrl("https://travelsats.ar/")).toBe("travelsats.ar");
  expect(lnurlDomainFromBaseUrl("https://travelsats.ar/lite")).toBe("travelsats.ar");
});

Deno.test("parseAppOrigins defaults to the BASE_URL origin when unset or blank", () => {
  expect(parseAppOrigins(undefined, "https://travelsats.ar")).toEqual(["https://travelsats.ar"]);
  expect(parseAppOrigins("   ", "https://lite-dev.travelsats.ar/")).toEqual([
    "https://lite-dev.travelsats.ar",
  ]);
  expect(parseAppOrigins("", "http://localhost:3000")).toEqual(["http://localhost:3000"]);
});

Deno.test("parseAppOrigins trims and splits a comma list and drops empty entries", () => {
  expect(parseAppOrigins("https://a.example, https://b.example ,,", "https://travelsats.ar")).toEqual([
    "https://a.example",
    "https://b.example",
  ]);
  expect(parseAppOrigins("https://dev.travelsats.ar", "https://lite-dev.travelsats.ar")).toEqual([
    "https://dev.travelsats.ar",
  ]);
});

Deno.test("the module exports one LNURL domain and keeps DOMAIN as an alias", () => {
  expect(LNURL_DOMAIN).toBe(new URL(Deno.env.get("BASE_URL")!).host.toLowerCase());
  expect(DOMAIN).toBe(LNURL_DOMAIN);
});
