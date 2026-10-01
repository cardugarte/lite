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
