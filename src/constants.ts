import { getPublicKey } from "@nostr/tools";
import { hexToBytes } from "npm:@noble/hashes@1.3.1/utils";

export const PORT = parseInt(Deno.env.get("PORT") || "8080");

/** Trimmed value of an environment variable, or undefined when it is unset or blank. */
export function readEnvValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

const baseUrl = readEnvValue(Deno.env.get("BASE_URL"));
if (!baseUrl) {
  console.log("no BASE_URL provided, exiting");
  Deno.exit(1);
}
// Annotated so the guaranteed-present value is visible to importers (the guard
// above runs at module load and exits before anything else can read it).
export const BASE_URL: string = baseUrl;

/**
 * The host Lite signs and publishes: `new URL(BASE_URL).host`, lowercased.
 * `URL.host` drops a default port the way the Breez server derives it. The
 * request `Host` header is never read, because behind the production rewrite
 * it is Lite's own host.
 */
export function lnurlDomainFromBaseUrl(base: string): string {
  return new URL(base).host.toLowerCase();
}

/** Origins allowed to call `/lnurlpay/*` from a browser. Defaults to the `BASE_URL` origin. */
export function parseAppOrigins(raw: string | undefined, base: string): string[] {
  const listed = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  return listed.length > 0 ? listed : [new URL(base).origin];
}

export const LNURL_DOMAIN = lnurlDomainFromBaseUrl(BASE_URL);
/** Alias kept for existing imports. */
export const DOMAIN = LNURL_DOMAIN;
export const APP_ORIGINS = parseAppOrigins(Deno.env.get("APP_ORIGINS"), BASE_URL);
const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.log("no DATABASE_URL provided, exiting");
  Deno.exit(1);
}
export const DATABASE_URL = databaseUrl;

export const NOSTR_NIP57_PRIVATE_KEY = Deno.env.get("NOSTR_NIP57_PRIVATE_KEY") || "";
export const NOSTR_NIP57_PUBLIC_KEY = NOSTR_NIP57_PRIVATE_KEY ? getPublicKey(hexToBytes(NOSTR_NIP57_PRIVATE_KEY)) : "";

export const BREEZ_API_KEY = Deno.env.get("BREEZ_API_KEY") || "";
export const SPARK_MINTER_MNEMONIC = Deno.env.get("SPARK_MINTER_MNEMONIC") || "";
export const SPARK_WEBHOOK_SECRET = Deno.env.get("SPARK_WEBHOOK_SECRET") || "";
export const SPARK_MINTER_STORAGE_DIR = Deno.env.get("SPARK_MINTER_STORAGE_DIR") || "./.spark-minter";
