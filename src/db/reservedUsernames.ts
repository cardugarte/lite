/**
 * Versioned reserved Lightning addresses. Changes go through review.
 * The migration seed in `drizzle/0006_reserved_usernames.sql` must stay
 * identical; `reservedUsernames.migration.test.ts` checks that.
 *
 * `reservedReason` compares `trim().toLowerCase()` with `.`, `-`, and `_`
 * removed. Exact names, prefixes, contains-needles, and key-like strings
 * are all blocked for new registration. Assignable destinations are blocked
 * the same way until an admin assigns one (that path is not this module).
 */

export const RESERVED_LISTS = {
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

export const RESERVED_PREFIXES = [
  "travelsats", "zuricata", "support", "soporte", "admin", "official", "oficial", "team",
  "staff", "mod", "security", "billing", "help", "ayuda",
] as const;

export const RESERVED_CONTAINS = ["travelsats", "zuricata"] as const;

export type ReservedReason = "exact" | "prefix" | "contains" | "key";

const EXACT = new Set<string>(Object.values(RESERVED_LISTS).flat());

const KEY_HEX = /^[0-9a-f]{64}$/;

/** Comparison key: trim, lowercase, then drop `.`, `-`, and `_`. */
export function normalizeReservedName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.\-_]/g, "");
}

/**
 * Why a username is reserved, or null when self-registration may use it.
 * Key-like names win over the lists. Exact wins over prefix, prefix over contains.
 */
export function reservedReason(input: string): ReservedReason | null {
  const normalized = normalizeReservedName(input);
  if (
    normalized.startsWith("npub1") ||
    normalized.startsWith("nsec1") ||
    KEY_HEX.test(normalized)
  ) {
    return "key";
  }
  if (EXACT.has(normalized)) return "exact";
  for (const prefix of RESERVED_PREFIXES) {
    if (normalized.startsWith(prefix)) return "prefix";
  }
  for (const needle of RESERVED_CONTAINS) {
    if (normalized.includes(needle)) return "contains";
  }
  return null;
}
