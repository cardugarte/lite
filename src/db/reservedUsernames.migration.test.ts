import { expect } from "jsr:@std/expect";

const MIGRATION = new URL("../../drizzle/0006_reserved_usernames.sql", import.meta.url);
const JOURNAL = new URL("../../drizzle/meta/_journal.json", import.meta.url);

async function migrationSql(): Promise<string> {
  try {
    return await Deno.readTextFile(MIGRATION);
  } catch {
    return "";
  }
}

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
