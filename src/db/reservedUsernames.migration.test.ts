import { expect } from "jsr:@std/expect";
import { RESERVED_CONTAINS, RESERVED_LISTS, RESERVED_PREFIXES } from "./reservedUsernames.ts";

const MIGRATION = new URL("../../drizzle/0006_reserved_usernames.sql", import.meta.url);
const JOURNAL = new URL("../../drizzle/meta/_journal.json", import.meta.url);

/** Rows the migration must seed, derived here from the data file. */
function expectedSeed(): string[] {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const [group, names] of Object.entries(RESERVED_LISTS)) {
    const category = group === "assignable" ? "assignable" : "hard";
    for (const name of names) {
      const key = `${name}|${category}|exact`;
      if (seen.has(`${name}|exact`)) {
        const previous = rows.find((row) => row.startsWith(`${name}|`) && row.endsWith("|exact"));
        if (previous !== key) throw new Error(`category clash for ${name}`);
        continue;
      }
      seen.add(`${name}|exact`);
      rows.push(key);
    }
  }
  for (const name of RESERVED_PREFIXES) rows.push(`${name}|hard|prefix`);
  for (const name of RESERVED_CONTAINS) rows.push(`${name}|hard|contains`);
  return rows.sort();
}

function seededRows(sql: string): string[] {
  return [...sql.matchAll(/\('([a-z0-9]+)', '(hard|assignable)', '(exact|prefix|contains)'\)/g)]
    .map((match) => `${match[1]}|${match[2]}|${match[3]}`)
    .sort();
}

async function migrationSql(): Promise<string> {
  try {
    return await Deno.readTextFile(MIGRATION);
  } catch {
    return "";
  }
}

Deno.test("the reserved_usernames seed matches the versioned data file", async () => {
  const sql = await migrationSql();
  expect(sql.length).toBeGreaterThan(0);
  const seeded = seededRows(sql);
  const expected = expectedSeed();
  expect(seeded).toEqual(expected);
  expect(new Set(seeded).size).toEqual(seeded.length);
});

Deno.test("the migration rejects reserved names in SQL and grandfathers existing rows", async () => {
  const sql = await migrationSql();
  expect(sql.length).toBeGreaterThan(0);
  const journal = JSON.parse(await Deno.readTextFile(JOURNAL)) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entry = journal.entries.find((item) => item.tag === "0006_reserved_usernames");
  expect(entry?.idx).toEqual(6);

  expect(sql.includes('CREATE TABLE IF NOT EXISTS "reserved_usernames"')).toEqual(true);
  expect(sql.includes("assigned_nostr_pubkey")).toEqual(true);
  expect(sql.includes("BEFORE INSERT OR UPDATE ON users")).toEqual(true);
  expect(sql.includes("BEFORE INSERT OR UPDATE ON binding_intents")).toEqual(true);
  expect(sql.includes("OLD.username IS NOT DISTINCT FROM NEW.username")).toEqual(true);
  expect(sql.includes("npub1")).toEqual(true);
  expect(sql.includes("nsec1")).toEqual(true);
  expect(sql.includes("[0-9a-f]{64}")).toEqual(true);
  expect(sql.includes("category = 'assignable'")).toEqual(true);
  // One NOT VALID check on users and one on binding_intents.
  expect(sql.match(/NOT VALID/g)?.length).toEqual(2);
  expect(sql.includes("char_length(username) BETWEEN 3 AND 64")).toEqual(true);
  // Same normalization as reservedReason: lowercase, trim, drop . - _
  expect(sql.includes("translate(")).toEqual(true);
  expect(/translate\([^)]*'[.\-_]+'/.test(sql) || sql.includes("'.-_'")).toEqual(true);
});
