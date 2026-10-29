import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "npm:postgres@3.4.5";
import { encrypt } from "./aesgcm.ts";
import { DB } from "./db.ts";
import { createUsernamesApp } from "../usernames.ts";

const databaseUrl = Deno.env.get("LITE_TEST_DATABASE_URL")?.trim() || "";

if (!databaseUrl) {
  console.log("ignore: LITE_TEST_DATABASE_URL is unset; integration tests need a disposable Postgres");
}

const migrationDir = new URL("../../drizzle/", import.meta.url);
const BEFORE = [
  "0000_greedy_phalanx.sql",
  "0001_white_prism.sql",
  "0002_green_frightful_four.sql",
  "0003_spark_destination.sql",
  "0004_breez_native_address.sql",
  "0005_breez_minter_schema.sql",
];
const RESERVED = "0006_reserved_usernames.sql";

const HELLO = "11".repeat(32);
const ZURI = "22".repeat(32);
const SHORT = "33".repeat(32);
const MENDOZA = "44".repeat(32);
const OTHER = "55".repeat(32);
const ALICE = "66".repeat(32);
const SPARK = "02" + "ab".repeat(32);
const SPARK_OTHER = "03" + "cd".repeat(32);

type Sql = ReturnType<typeof postgres>;

function databaseNamed(name: string): string {
  return databaseUrl.replace(/\/[^/?]*(\?.*)?$/, `/${name}$1`);
}

async function applySql(sql: Sql, text: string): Promise<void> {
  const statements = text
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function applyNamed(sql: Sql, names: string[]): Promise<void> {
  for (const name of names) {
    await applySql(sql, await Deno.readTextFile(new URL(name, migrationDir)));
  }
}

async function withDatabase(fn: (sql: Sql, url: string) => Promise<void>): Promise<void> {
  const name = `lite_it_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseNamed("postgres"), { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const url = databaseNamed(name);
  const sql = postgres(url, { max: 1 });
  try {
    await fn(sql, url);
  } finally {
    await sql.end({ timeout: 5 });
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}' and pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.end({ timeout: 5 });
  }
}

async function insertNwc(sql: Sql, username: string, nostrPubkey: string, secret: string): Promise<void> {
  await sql`
    insert into users (connection_secret, username, nostr_pubkey, destination, spark_identity_pubkey)
    values (${secret}, ${username}, ${nostrPubkey}, 'nwc', null)
  `;
}

Deno.test({
  name: "0006 keeps hello and zuricata, blocks new reserved names, and allows an assigned destination",
  ignore: !databaseUrl,
  async fn() {
    const secret = await encrypt("enc-hello");
    await withDatabase(async (sql, url) => {
      await applyNamed(sql, BEFORE);
      await insertNwc(sql, "hello", HELLO, secret);
      await insertNwc(sql, "zuricata", ZURI, secret);
      await insertNwc(sql, "ab", SHORT, secret);
      await sql`
        insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
        values ('hello', ${HELLO}, ${SPARK}, ${new Date("2026-03-01T12:10:00.000Z")})
      `;

      await applyNamed(sql, [RESERVED]);

      const kept = await sql<{ username: string }[]>`
        select username from users order by username
      `;
      expect(kept.map((row) => row.username)).toEqual(["ab", "hello", "zuricata"]);
      // NOT VALID skips the migration scan. Postgres still checks the new row
      // on a later UPDATE, so a legacy name shorter than 3 cannot be touched
      // until it is renamed. hello and zuricata pass the check.
      await expect(sql`update users set connection_secret = ${secret} where username = 'ab'`)
        .rejects.toThrow("users_username_min_length_format");

      await sql`update users set created_at = '2020-01-02T00:00:00.000Z' where username = 'hello'`;
      await sql`update users set connection_secret = ${secret} where username = 'zuricata'`;
      await sql`update users set username = 'hello' where username = 'hello'`;
      await sql`
        update binding_intents
        set expires_at = ${new Date("2026-04-01T12:10:00.000Z")}
        where username = 'hello'
      `;

      const stillHello = await sql<{ day: string }[]>`
        select to_char(created_at, 'YYYY-MM-DD') as day from users where username = 'hello'
      `;
      expect(stillHello[0].day).toEqual("2020-01-02");

      await expect(insertNwc(sql, "admin", ALICE, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "ad.min", ALICE, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "mytravelsats", ALICE, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "staffroom", ALICE, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "npub1qqqqqqqqqqqqq", ALICE, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "ab".repeat(32), ALICE, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "mendoza", MENDOZA, secret)).rejects.toThrow("not available");
      await expect(insertNwc(sql, "xy", ALICE, secret)).rejects.toThrow(/users_username_min_length_format|check constraint/i);

      await insertNwc(sql, "alice", ALICE, secret);
      await insertNwc(sql, "first.last", OTHER, secret);
      await insertNwc(sql, "user_name", "77".repeat(32), secret);

      await sql`
        update reserved_usernames
        set assigned_nostr_pubkey = ${MENDOZA}
        where name = 'mendoza' and match = 'exact'
      `;
      await insertNwc(sql, "mendoza", MENDOZA, secret);
      await expect(sql`
        insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
        values ('mendoza', ${OTHER}, ${SPARK_OTHER}, ${new Date("2026-03-01T12:10:00.000Z")})
      `).rejects.toThrow("not available");
      await expect(sql`
        insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
        values ('bariloche', ${MENDOZA}, ${SPARK_OTHER}, ${new Date("2026-03-01T12:10:00.000Z")})
      `).rejects.toThrow("not available");
      await sql`
        update reserved_usernames
        set assigned_nostr_pubkey = ${MENDOZA}
        where name = 'bariloche' and match = 'exact'
      `;
      await sql`
        insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
        values ('bariloche', ${MENDOZA}, ${SPARK}, ${new Date("2026-03-01T12:10:00.000Z")})
      `;

      await expect(sql`
        update reserved_usernames
        set assigned_nostr_pubkey = ${HELLO}
        where name = 'admin' and match = 'exact'
      `).rejects.toThrow(/reserved_usernames_assignment|check constraint/i);

      await expect(sql`
        update users set username = 'admin' where username = 'hello'
      `).rejects.toThrow("not available");
      await expect(sql`
        update binding_intents set username = 'support' where username = 'hello'
      `).rejects.toThrow("not available");

      const names = await sql<{ username: string }[]>`select username from users where username in ('hello', 'zuricata') order by username`;
      expect(names.map((row) => row.username)).toEqual(["hello", "zuricata"]);

      const db = new DB(url);
      try {
        expect((await db.findUser("hello")).nostrPubkey).toEqual(HELLO);
        expect((await db.findUser("zuricata")).username).toEqual("zuricata");
      } finally {
        await db.close();
      }
    });
  },
});

Deno.test({
  name: "reserved_usernames is the registration check, including an assignment for one pubkey",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (sql, url) => {
      await applyNamed(sql, [...BEFORE, RESERVED]);
      const { DB: Repository } = await import("./db.ts");
      const db = new Repository(url);
      try {
        expect(await db.isReservedUsername("admin", null)).toEqual(true);
        expect(await db.isReservedUsername("Ad.Min", null)).toEqual(true);
        expect(await db.isReservedUsername("admin2", null)).toEqual(true);
        expect(await db.isReservedUsername("xadmin", null)).toEqual(false);
        expect(await db.isReservedUsername("mytravelsats", null)).toEqual(true);
        expect(await db.isReservedUsername("andes", null)).toEqual(false);
        expect(await db.isReservedUsername("mendoza", null)).toEqual(true);
        expect(await db.isReservedUsername("mendoza", MENDOZA)).toEqual(true);
        const assigned = await db.assignReservedUsername("mendoza", "exact", MENDOZA);
        expect(assigned.kind).toEqual("assigned");
        expect(await db.isReservedUsername("mendoza", MENDOZA)).toEqual(false);
        expect(await db.isReservedUsername("mendoza", OTHER)).toEqual(true);
        expect(await db.isReservedUsername("admin", MENDOZA)).toEqual(true);
        await sql`
          insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
          values ('mendoza', ${MENDOZA}, ${SPARK}, ${new Date("2026-03-01T12:10:00.000Z")})
        `;
        expect(await db.isReservedUsername("mendoza", SPARK, new Date("2026-03-01T12:00:00.000Z"))).toEqual(false);
        expect(await db.isReservedUsername("mendoza", SPARK, new Date("2026-03-01T13:00:00.000Z"))).toEqual(true);
        const page = await db.listReservedUsernames({ q: "men", category: "assignable", match: "exact", limit: 10, offset: 0 });
        expect(page.total).toEqual(1);
        expect(page.rows[0].name).toEqual("mendoza");
        expect(page.rows[0].assignedNostrPubkey).toEqual(MENDOZA);
      } finally {
        await db.close();
      }
    });
  },
});

Deno.test({
  name: "mendoza, sanmartin, and bariloche_ availability follow the assignable seed",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (_sql, url) => {
      await applyNamed(_sql, [...BEFORE, RESERVED]);
      const { DB: Repository } = await import("./db.ts");
      const db = new Repository(url);
      const app = createUsernamesApp(db, () => new Date("2026-03-01T12:00:00.000Z"));
      const ask = async (path: string) => {
        const res = await app.request(path);
        expect(res.status).toEqual(200);
        return await res.json();
      };
      try {
        expect(await ask("/mendoza/availability")).toEqual({ available: false });
        expect(await ask(`/mendoza/availability?pubkey=${MENDOZA}`)).toEqual({ available: false });
        expect(await ask("/sanmartin/availability")).toEqual({ available: false });
        expect(await ask(`/sanmartin/availability?pubkey=${OTHER}`)).toEqual({ available: false });
        expect(await ask("/bariloche_/availability")).toEqual({ available: false });
        expect((await db.assignReservedUsername("mendoza", "exact", MENDOZA)).kind).toEqual("assigned");
        expect((await db.assignReservedUsername("sanmartin", "exact", OTHER)).kind).toEqual("assigned");
        expect(await ask(`/mendoza/availability?pubkey=${MENDOZA}`)).toEqual({ available: true });
        expect(await ask(`/mendoza/availability?pubkey=${OTHER}`)).toEqual({ available: false });
        expect(await ask(`/sanmartin/availability?pubkey=${OTHER}`)).toEqual({ available: true });
        expect(await ask("/sanmartin/availability")).toEqual({ available: false });
        expect(await ask("/bariloche_/availability")).toEqual({ available: false });
        const exact = await _sql<{ name: string; category: string }[]>`
          select name, category from reserved_usernames where match = 'exact'
        `;
        const names = exact.map((row) => row.name);
        expect(new Set(names).size).toEqual(names.length);
        expect(exact.find((row) => row.name === "sanmartin")?.category).toEqual("assignable");
        expect(exact.find((row) => row.name === "mendoza")?.category).toEqual("assignable");
        expect(exact.find((row) => row.name === "hello")?.category).toEqual("hard");
        expect(exact.find((row) => row.name === "zuricata")?.category).toEqual("hard");
      } finally {
        await db.close();
      }
    });
  },
});

Deno.test({
  name: "drizzle migrate applies 0006 and seeds reserved_usernames",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (sql) => {
      const db = drizzle(sql);
      await migrate(db, { migrationsFolder: "./drizzle" });
      const [count] = await sql<{ n: string }[]>`select count(*)::text as n from reserved_usernames`;
      expect(Number(count.n)).toBeGreaterThan(300);
      const [hello] = await sql<{ category: string; match: string }[]>`
        select category, match from reserved_usernames where name = 'hello' and match = 'exact'
      `;
      expect(hello).toEqual({ category: "hard", match: "exact" });
      const [mendoza] = await sql<{ category: string; assigned_nostr_pubkey: string | null }[]>`
        select category, assigned_nostr_pubkey from reserved_usernames
        where name = 'mendoza' and match = 'exact'
      `;
      expect(mendoza).toEqual({ category: "assignable", assigned_nostr_pubkey: null });
    });
  },
});
