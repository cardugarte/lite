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
