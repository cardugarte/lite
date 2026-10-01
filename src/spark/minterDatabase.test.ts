import { expect } from "jsr:@std/expect";
import { deriveMinterDatabaseUrl } from "./minterDatabase.ts";

const SEARCH_PATH = "-c search_path=breez_minter";

Deno.test("a URL without params gets only the breez_minter search_path", () => {
  const url = new URL(deriveMinterDatabaseUrl("postgres://lite:pw@db.internal:5432/lite"));
  expect(url.protocol).toEqual("postgres:");
  expect(url.username).toEqual("lite");
  expect(url.password).toEqual("pw");
  expect(url.host).toEqual("db.internal:5432");
  expect(url.pathname).toEqual("/lite");
  expect([...url.searchParams.keys()]).toEqual(["options"]);
  expect(url.searchParams.get("options")).toEqual(SEARCH_PATH);
});

Deno.test("existing params such as sslmode are preserved", () => {
  const url = new URL(deriveMinterDatabaseUrl("postgresql://u:p@h/db?sslmode=require&application_name=lite"));
  expect(url.searchParams.get("sslmode")).toEqual("require");
  expect(url.searchParams.get("application_name")).toEqual("lite");
  expect(url.searchParams.get("options")).toEqual(SEARCH_PATH);
});

Deno.test("an existing options value is merged, not replaced", () => {
  const url = new URL(deriveMinterDatabaseUrl("postgres://u:p@h/db?options=-c%20statement_timeout%3D5000&sslmode=require"));
  expect(url.searchParams.getAll("options")).toEqual([`-c statement_timeout=5000 ${SEARCH_PATH}`]);
  expect(url.searchParams.get("sslmode")).toEqual("require");
});

Deno.test("the options value is percent-encoded, never carrying a raw space", () => {
  const derived = deriveMinterDatabaseUrl("postgres://u:p@h/db");
  expect(derived.includes(" ")).toEqual(false);
  expect(derived.includes("options=-c%20search_path%3Dbreez_minter")).toEqual(true);
});

Deno.test("a password with reserved characters survives", () => {
  const url = new URL(deriveMinterDatabaseUrl("postgres://u:p%40ss%2Fw@h/db"));
  expect(decodeURIComponent(url.password)).toEqual("p@ss/w");
});

Deno.test("an explicit override is used verbatim", () => {
  const override = "postgres://minter:x@other:5432/minterdb?sslmode=disable";
  expect(deriveMinterDatabaseUrl("postgres://u:p@h/db", override)).toEqual(override);
  expect(deriveMinterDatabaseUrl("postgres://u:p@h/db", "   ")).toContain("search_path");
});
