import { expect } from "jsr:@std/expect";
import {
  RESERVED_CONTAINS,
  RESERVED_LISTS,
  RESERVED_PREFIXES,
  reservedReason,
} from "./reservedUsernames.ts";

/** Spec lists, 2026-10-29. The data file must match these exactly. */
const EXPECTED = {
  brand: [
    "travelsats", "travelsat", "travelsatsar", "travel", "sats", "zuricata", "lazuricata",
    "xplorers", "xplorer", "explorers", "baqueano", "baqueanos", "fogon", "cordillera",
    "condor", "ridgeline", "refugio", "pionero", "pioneros", "hornero", "escriba", "reserva",
    "reservas", "posta", "escarapela", "escarapelas", "embajador", "embajadores", "ambassador",
    "ambassadors", "club", "clubs", "clubes", "comunidad", "community", "grokbot", "bot",
    "agent", "agents", "ai", "ia",
  ],
  personal: ["carlos", "cardugarte", "carlosdugarte", "soycarlosdugarte"],
  roles: [
    "admin", "administrator", "administrador", "root", "superuser", "sysadmin", "support",
    "soporte", "help", "ayuda", "helpdesk", "info", "contact", "contacto", "hello", "hola",
    "billing", "facturacion", "pagos", "payments", "cobros", "security", "seguridad", "abuse",
    "postmaster", "hostmaster", "webmaster", "noreply", "donotreply", "mailerdaemon", "mail",
    "email", "legal", "privacy", "privacidad", "terms", "terminos", "press", "prensa", "media",
    "team", "equipo", "staff", "official", "oficial", "mod", "mods", "moderator", "moderador",
    "owner", "founder", "fundador", "ceo", "cto", "sales", "ventas", "marketing", "jobs",
    "empleos", "careers", "hr", "rrhh", "ops", "operaciones", "status", "notifications",
    "notificaciones", "alerts", "newsletter", "news", "noticias", "blog",
  ],
  technical: [
    "api", "www", "app", "apps", "web", "dev", "development", "staging", "stage", "preview",
    "prod", "production", "test", "tests", "testing", "demo", "sandbox", "beta", "alpha",
    "localhost", "null", "undefined", "nan", "true", "false", "none", "nil", "void",
    "anonymous", "anon", "guest", "system", "daemon", "server", "host", "cdn", "static",
    "assets", "public", "private", "internal", "health", "ping", "metrics", "cron", "webhook",
    "webhooks", "callback", "redirect", "oauth", "auth", "login", "logout", "signin", "signup",
    "register", "registro", "createaccount", "account", "accounts", "cuenta", "settings",
    "config", "configuracion", "profile", "profiles", "perfil", "me", "self", "user", "users",
    "usuario", "usuarios", "wallet", "invoice", "invoices", "factura", "lnurlp", "lnurl",
    "lnurlpay", "lnurlproxy", "wellknown", "nostr", "nostrjson", "nip05", "npub", "nsec",
    "relay", "relays", "blossom", "nwc", "spark", "bindingintents", "nwcbind", "recover",
    "available", "metadata", "unauthorized", "offline", "serwist", "sw", "manifest", "favicon",
    "robots", "sitemap", "sharetarget", "models", "names", "mentions", "push", "reviews",
    "weather", "image", "images", "about", "activities", "booking", "bookings", "contact",
    "create", "emergency", "links", "messages", "notes", "privacy", "services", "waitlist",
    "welcome", "analytics", "dashboard",
  ],
  payments: [
    "bitcoin", "btc", "xbt", "lightning", "ln", "lnd", "sat", "satoshi", "satoshis",
    "satoshinakamoto", "nakamoto", "wallets", "billetera", "breez", "alby", "getalby", "zap",
    "zaps", "zapper", "tips", "tip", "propina", "propinas", "donate", "donar", "donation",
    "donations", "donaciones", "treasury", "tesoreria", "vault", "custody", "exchange", "swap",
    "faucet", "refund", "reembolso", "airdrop", "giveaway", "sorteo", "usdt", "usdc", "usdb",
    "usd", "ars", "peso", "pesos", "dolar", "stable", "stablecoin", "lnbits", "phoenix", "wos",
    "walletofsatoshi", "strike", "blink", "muun", "cashu", "fedimint", "nostrwallet",
  ],
  institutions: [
    "afip", "arca", "bcra", "anses", "mercadopago", "gobierno", "gob", "gov", "gobar",
    "presidencia", "ministerio", "municipalidad", "muni", "policia", "gendarmeria", "aduana",
    "migraciones", "turismo", "emetur", "inprotur", "minturdep", "argentina", "parquesnacionales",
    "apn",
  ],
  short: [
    "eth", "eur", "org", "com", "net", "dao", "nft", "sms", "faq", "vip", "pro", "top", "max",
  ],
  assignable: [
    "mendoza", "bariloche", "patagonia", "ushuaia", "aconcagua", "cuyo", "neuquen", "salta",
    "jujuy", "cordoba", "rosario", "buenosaires", "caba", "iguazu", "calafate", "chalten",
    "malargue", "payunia", "sanrafael", "tupungato", "uspallata", "valledeuco",
  ],
} as const;

const EXPECTED_PREFIXES = [
  "travelsats", "zuricata", "support", "soporte", "admin", "official", "oficial", "team",
  "staff", "mod", "security", "billing", "help", "ayuda",
] as const;

const EXPECTED_CONTAINS = ["travelsats", "zuricata"] as const;

Deno.test("the reserved-name data file keeps every spec category, prefix, and contains entry", () => {
  expect(RESERVED_LISTS).toEqual(EXPECTED);
  expect(RESERVED_PREFIXES).toEqual(EXPECTED_PREFIXES);
  expect(RESERVED_CONTAINS).toEqual(EXPECTED_CONTAINS);
});

Deno.test("reservedReason blocks every exact hard and assignable name", () => {
  const misses: string[] = [];
  for (const names of Object.values(EXPECTED)) {
    for (const name of names) {
      if (reservedReason(name) !== "exact") misses.push(name);
    }
  }
  expect(misses).toEqual([]);
});

Deno.test("reservedReason normalizes case and strips dots, hyphens, and underscores", () => {
  expect(reservedReason("  Hello  ")).toBe("exact");
  expect(reservedReason("HEL.LO")).toBe("exact");
  expect(reservedReason("he-llo")).toBe("exact");
  expect(reservedReason("hel_lo")).toBe("exact");
  expect(reservedReason("Zu.ri-cata")).toBe("exact");
  expect(reservedReason("tra.velsats")).toBe("exact");
  expect(reservedReason("men.doza")).toBe("exact");
});

Deno.test("reservedReason blocks prefixes only when the name starts with one", () => {
  expect(reservedReason("admin")).toBe("exact");
  expect(reservedReason("admin2")).toBe("prefix");
  expect(reservedReason("ad-min-extra")).toBe("prefix");
  expect(reservedReason("soporteweb")).toBe("prefix");
  expect(reservedReason("officially")).toBe("prefix");
  expect(reservedReason("teamwork")).toBe("prefix");
  expect(reservedReason("module")).toBe("prefix");
  expect(reservedReason("securityteam")).toBe("prefix");
  expect(reservedReason("xadmin")).toBeNull();
  expect(reservedReason("steam")).toBeNull();
  expect(reservedReason("comod")).toBeNull();
});

Deno.test("reservedReason blocks names containing travelsats or zuricata", () => {
  expect(reservedReason("mytravelsats")).toBe("contains");
  expect(reservedReason("xx.zuricata.yy")).toBe("contains");
  expect(reservedReason("notzuricata")).toBe("contains");
  expect(reservedReason("zuricataextra")).toBe("prefix");
  expect(reservedReason("travelsats")).toBe("exact");
});

Deno.test("reservedReason blocks key-like names", () => {
  expect(reservedReason("npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe("key");
  expect(reservedReason("Npub1QQQ")).toBe("key");
  expect(reservedReason("nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe("key");
  expect(reservedReason("NSEC1abc")).toBe("key");
  expect(reservedReason("ab".repeat(32))).toBe("key");
  expect(reservedReason("AB".repeat(32))).toBe("key");
  expect(reservedReason("a".repeat(64))).toBe("key");
  // "o" is not hex, so a mod-prefixed string is a prefix even at length 64.
  expect(reservedReason("mod" + "a".repeat(61))).toBe("prefix");
  expect(reservedReason("a".repeat(63))).toBeNull();
  expect(reservedReason("npub")).toBe("exact");
  expect(reservedReason("nsec")).toBe("exact");
});

Deno.test("reservedReason leaves ordinary names and non-prefix fragments free", () => {
  for (const name of ["alice", "bob", "traveling", "mysats", "botany", "andes", "patagon", "mendozacity"]) {
    expect(reservedReason(name)).toBeNull();
  }
  expect(reservedReason("")).toBeNull();
  expect(reservedReason("...")).toBeNull();
});

Deno.test("assignable destinations are reserved for self-registration", () => {
  for (const name of EXPECTED.assignable) {
    expect(reservedReason(name)).toBe("exact");
  }
  expect(reservedReason("mendoza-city")).toBeNull();
});
