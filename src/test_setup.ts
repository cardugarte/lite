const ZERO_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

if (!Deno.env.get("BASE_URL")) {
  Deno.env.set("BASE_URL", "http://lnaddr.test");
}
if (!Deno.env.get("DATABASE_URL")) {
  Deno.env.set("DATABASE_URL", "postgresql://u:p@127.0.0.1:5432/alby");
}
if (!Deno.env.get("ENCRYPTION_KEY")) {
  Deno.env.set("ENCRYPTION_KEY", ZERO_KEY);
}
if (!Deno.env.get("NOSTR_NIP57_PRIVATE_KEY")) {
  Deno.env.set("NOSTR_NIP57_PRIVATE_KEY", "11".repeat(32));
}
