import { expect } from "jsr:@std/expect";

const FORBIDDEN = [
  "isAllowed" + "UsersOrigin",
  "users" + "RequestAllowed",
  "users-" + "origin",
  "issue" + "RebindToken",
  "rebind" + "User",
  "hash" + "RebindToken",
];

async function typescriptFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...await typescriptFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

Deno.test("origin allow-list and rebind helpers are absent from src", async () => {
  const src = new URL(".", import.meta.url);
  const files = await typescriptFiles(decodeURIComponent(src.pathname));
  const hits: string[] = [];
  for (const file of files) {
    if (file.endsWith("/architecture.test.ts")) continue;
    const text = await Deno.readTextFile(file);
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hits.push(`${file} contains ${needle}`);
    }
  }
  let originModuleExists = true;
  try {
    await Deno.stat(new URL("./users-origin.ts", import.meta.url));
  } catch {
    originModuleExists = false;
  }
  expect(originModuleExists).toEqual(false);
  expect(hits).toEqual([]);
});

const REBIND_NAMES = ["rebind" + "Tokens", "rebind" + "_tokens"];
const SKIP_DIRS = new Set([".git", "node_modules", "drizzle", ".atl"]);

async function textFilesOutsideDrizzle(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      found.push(...await textFilesOutsideDrizzle(path));
    } else if (entry.isFile && /\.(ts|md|sql|json|toml)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

Deno.test("rebind table names are absent outside drizzle", async () => {
  const root = decodeURIComponent(new URL("../", import.meta.url).pathname);
  const files = await textFilesOutsideDrizzle(root.replace(/\/$/, ""));
  const hits: string[] = [];
  for (const file of files) {
    if (file.endsWith("/architecture.test.ts")) continue;
    const text = await Deno.readTextFile(file);
    for (const needle of REBIND_NAMES) {
      if (text.includes(needle)) hits.push(`${file} contains ${needle}`);
    }
  }
  expect(hits).toEqual([]);
});

const DOMAIN_IMPORT = /import\s*\{[^}]*\bDOMAIN\b[^}]*\}\s*from\s*"(?:\.{1,2}\/)+constants\.ts"/;

Deno.test("no module imports the DOMAIN alias; addresses use LNURL_DOMAIN", async () => {
  const src = new URL(".", import.meta.url);
  const files = await typescriptFiles(decodeURIComponent(src.pathname));
  const hits: string[] = [];
  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith("/constants.ts")) continue;
    const text = await Deno.readTextFile(file);
    if (DOMAIN_IMPORT.test(text)) hits.push(file);
  }
  expect(hits).toEqual([]);
});

// ---------------------------------------------------------------------------
// The documents say what the code does. Settlement is no longer webhook-only
// (ADR 0014), and what this stage added is written down.
// ---------------------------------------------------------------------------

const DOCUMENTS = ["README.md", "CLAUDE.md", "src/docs/deployment-guide.md"];
const repoFile = (path: string) => Deno.readTextFile(new URL(`../${path}`, import.meta.url));

Deno.test("no document says Spark settlement is webhook-only", async () => {
  const stale = /webhook[- ]only|settled by the webhook alone|accepted gap|no reconciliation job/i;
  const hits: string[] = [];
  for (const path of DOCUMENTS) {
    const match = (await repoFile(path)).match(stale);
    if (match) hits.push(`${path}: ${match[0]}`);
  }
  expect(hits).toEqual([]);
});

Deno.test("the README documents the expiry setting, the status field and the SSP reconcile", async () => {
  const readme = await repoFile("README.md");
  for (const needle of ["INVOICE_EXPIRY_SECS", "payment_status", "Reconciling a lost webhook", "ADR 0014"]) {
    expect({ needle, documented: readme.includes(needle) }).toEqual({ needle, documented: true });
  }
  for (const path of ["CLAUDE.md", "src/docs/deployment-guide.md"]) {
    const text = await repoFile(path);
    expect({ path, documented: text.includes("INVOICE_EXPIRY_SECS") || path === "CLAUDE.md" }).toEqual({ path, documented: true });
  }
  expect((await repoFile("CLAUDE.md")).includes("spark/reconcile.ts")).toEqual(true);
});

Deno.test("every event the settlement code logs is in the README", async () => {
  const events = new Set<string>();
  for (const file of ["spark/reconcile.ts", "nwc/nwcPool.ts", "lnurlp.ts"]) {
    const text = await Deno.readTextFile(new URL(`./${file}`, import.meta.url));
    for (const match of text.matchAll(/event: "([a-z_]+)"/g)) events.add(match[1]);
  }
  // The files above log these; a count of zero would mean the scan silently found nothing.
  expect(events.size).toBeGreaterThanOrEqual(5);
  const readme = await repoFile("README.md");
  expect([...events].filter((event) => !readme.includes(`\`${event}\``)).sort()).toEqual([]);
});
