import { expect } from "jsr:@std/expect";
import postgres from "npm:postgres@3.4.5";
import type { DB } from "./db.ts";

const databaseUrl = Deno.env.get("LITE_TEST_DATABASE_URL")?.trim() || "";

if (!databaseUrl) {
  console.log(
    "ignore: LITE_TEST_DATABASE_URL is unset; integration tests need a disposable Postgres",
  );
}

const migrationDir = new URL("../../drizzle/", import.meta.url);
const THROUGH_0003 = [
  "0000_greedy_phalanx.sql",
  "0001_white_prism.sql",
  "0002_green_frightful_four.sql",
  "0003_spark_destination.sql",
];
const MIGRATION_0004 = "0004_breez_native_address.sql";
const REBIND_TABLE = "rebind" + "_tokens";

const SPARK_KEY = "02" + "ab".repeat(32);
const SPARK_KEY_UPPER = "02" + "AB".repeat(32);
const SPARK_KEY_OTHER = "03" + "cd".repeat(32);
const SPARK_KEY_04 = "04" + "ab".repeat(32);
const NPUB = "11".repeat(32);
const NPUB_OTHER = "22".repeat(32);
const NPUB_THIRD = "33".repeat(32);
const NWC_URL =
  "nostr+walletconnect://0ba9d3de7e3e201aad29ee6b9fca20da0e5fc638c4b0513671eaea9c16a3989f?relay=wss://relay.getalby.com/v1&secret=bdaec8619bcf63a7c797043092ef72a6f62270c0f832561faf8f51f0cfdfce33";
const ZERO_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
  });
}

async function applyNamed(sql: Sql, names: string[]): Promise<void> {
  for (const name of names) {
    await applySql(sql, await Deno.readTextFile(new URL(name, migrationDir)));
  }
}

async function withDatabase(
  fn: (sql: Sql, url: string) => Promise<void>,
): Promise<void> {
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

type SeedUser = {
  username: string;
  nostrPubkey: string;
  connectionSecret: string | null;
  destination: string | null;
  sparkIdentityPubkey: string | null;
};

async function insertUser(sql: Sql, user: SeedUser): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    insert into users (
      connection_secret, username, nostr_pubkey, destination, spark_identity_pubkey
    ) values (
      ${user.connectionSecret},
      ${user.username},
      ${user.nostrPubkey},
      ${user.destination},
      ${user.sparkIdentityPubkey}
    )
    returning id
  `;
  return Number(rows[0].id);
}

async function schemaFingerprint(sql: Sql) {
  const [flags] = await sql.unsafe<{
    rebind: boolean;
    intents: boolean;
    minted_by: boolean;
    destination_nullable: string;
  }[]>(`
    select
      to_regclass('public.${REBIND_TABLE}') is not null as rebind,
      to_regclass('public.binding_intents') is not null as intents,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'invoices'
          and column_name = 'minted_by'
      ) as minted_by,
      (
        select is_nullable from information_schema.columns
        where table_schema = 'public'
          and table_name = 'users'
          and column_name = 'destination'
      ) as destination_nullable
  `);
  const users = await sql<SeedUser[]>`
    select
      username,
      nostr_pubkey as "nostrPubkey",
      connection_secret as "connectionSecret",
      destination,
      spark_identity_pubkey as "sparkIdentityPubkey"
    from users
    order by id
  `;
  return { flags, users };
}

function raiseMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function expectMigrationAbort(
  seed: SeedUser[],
  secretSentinel: string,
  keySentinel: string,
): Promise<void> {
  await withDatabase(async (sql) => {
    await applyNamed(sql, THROUGH_0003);
    for (const user of seed) await insertUser(sql, user);
    const before = await schemaFingerprint(sql);
    let failed = false;
    try {
      await applyNamed(sql, [MIGRATION_0004]);
    } catch (error) {
      failed = true;
      const message = raiseMessage(error);
      expect(message.startsWith("0004:")).toBe(true);
      expect(message.includes(secretSentinel)).toBe(false);
      expect(message.includes(keySentinel)).toBe(false);
    }
    expect(failed).toBe(true);
    expect(await schemaFingerprint(sql)).toEqual(before);
  });
}

async function expectSqlState(
  sql: Sql,
  code: string,
  run: () => Promise<unknown>,
): Promise<void> {
  let failed = false;
  try {
    await run();
  } catch (error) {
    failed = true;
    const state = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    expect(state).toBe(code);
  }
  expect(failed).toBe(true);
}

Deno.test({
  name: "smoke: local integration database accepts a connection",
  ignore: !databaseUrl,
  async fn() {
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
    try {
      const rows = await sql<{ ok: number }[]>`select 1 as ok`;
      expect(Number(rows[0].ok)).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: "migration chain 0000 to 0004 on an empty database",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (sql) => {
      await applyNamed(sql, [...THROUGH_0003, MIGRATION_0004]);
      const [flags] = await sql.unsafe<{
        users: string | null;
        invoices: string | null;
        intents: string | null;
        statements: string | null;
        rebind: string | null;
        destination_nullable: string;
        minted_by_nullable: string;
      }[]>(`
        select
          to_regclass('public.users')::text as users,
          to_regclass('public.invoices')::text as invoices,
          to_regclass('public.binding_intents')::text as intents,
          to_regclass('public.signed_statements')::text as statements,
          to_regclass('public.${REBIND_TABLE}')::text as rebind,
          (
            select is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'users' and column_name = 'destination'
          ) as destination_nullable,
          (
            select is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = 'invoices' and column_name = 'minted_by'
          ) as minted_by_nullable
      `);
      expect(flags.users).toBe("users");
      expect(flags.invoices).toBe("invoices");
      expect(flags.intents).toBe("binding_intents");
      expect(flags.statements).toBe("signed_statements");
      expect(flags.rebind).toBeNull();
      expect(flags.destination_nullable).toBe("NO");
      expect(flags.minted_by_nullable).toBe("NO");
    });
  },
});

Deno.test({
  name: "pre-0004 rows become explicit destinations, lowercase, and invoice provenance",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (sql) => {
      await applyNamed(sql, THROUGH_0003);
      const nwcA = await insertUser(sql, {
        username: "bob",
        nostrPubkey: NPUB,
        connectionSecret: "secret-bob",
        destination: null,
        sparkIdentityPubkey: null,
      });
      const nwcB = await insertUser(sql, {
        username: "Carol",
        nostrPubkey: "AB".repeat(32),
        connectionSecret: "secret-carol",
        destination: null,
        sparkIdentityPubkey: null,
      });
      const spark = await insertUser(sql, {
        username: "Dave",
        nostrPubkey: "CD".repeat(32),
        connectionSecret: null,
        destination: "spark",
        sparkIdentityPubkey: SPARK_KEY_UPPER,
      });
      await sql`
        insert into invoices (user_id, amount, payment_request, payment_hash)
        values
          (${nwcA}, 1000, 'pr-nwc', 'hash-nwc'),
          (${spark}, 2000, 'pr-spark', 'hash-spark')
      `;
      await sql.unsafe(
        `insert into ${REBIND_TABLE} (username, token_hash) values ('bob', 'hash-token')`,
      );
      await applyNamed(sql, [MIGRATION_0004]);

      const users = await sql<{
        username: string;
        nostr_pubkey: string;
        destination: string;
        spark_identity_pubkey: string | null;
      }[]>`
        select username, nostr_pubkey, destination, spark_identity_pubkey
        from users
        order by id
      `;
      expect(users).toEqual([
        {
          username: "bob",
          nostr_pubkey: NPUB,
          destination: "nwc",
          spark_identity_pubkey: null,
        },
        {
          username: "carol",
          nostr_pubkey: "ab".repeat(32),
          destination: "nwc",
          spark_identity_pubkey: null,
        },
        {
          username: "dave",
          nostr_pubkey: "cd".repeat(32),
          destination: "spark",
          spark_identity_pubkey: SPARK_KEY,
        },
      ]);
      const invoices = await sql<{
        user_id: number;
        minted_by: string;
        receiver_pubkey: string | null;
      }[]>`
        select user_id, minted_by, receiver_pubkey
        from invoices
        order by user_id
      `;
      expect(invoices).toEqual([
        { user_id: nwcA, minted_by: "nwc", receiver_pubkey: null },
        { user_id: spark, minted_by: "spark", receiver_pubkey: SPARK_KEY },
      ]);
      expect(nwcB).toBeGreaterThan(0);
      const [rebind] = await sql.unsafe<{ rel: string | null }[]>(
        `select to_regclass('public.${REBIND_TABLE}')::text as rel`,
      );
      expect(rebind.rel).toBeNull();
    });
  },
});

Deno.test({
  name: "both credentials abort 0004 without changing schema or data",
  ignore: !databaseUrl,
  fn: () =>
    expectMigrationAbort(
      [{
        username: "both",
        nostrPubkey: NPUB,
        connectionSecret: "CREDENTIAL-SENTINEL-9f3a",
        destination: null,
        sparkIdentityPubkey: SPARK_KEY,
      }],
      "CREDENTIAL-SENTINEL-9f3a",
      SPARK_KEY,
    ),
});

Deno.test({
  name: "a row with no credential aborts 0004",
  ignore: !databaseUrl,
  fn: () =>
    expectMigrationAbort(
      [{
        username: "empty",
        nostrPubkey: NPUB,
        connectionSecret: null,
        destination: null,
        sparkIdentityPubkey: null,
      }],
      "CREDENTIAL-SENTINEL-9f3a",
      SPARK_KEY,
    ),
});

Deno.test({
  name: "destination spark without a key aborts 0004",
  ignore: !databaseUrl,
  fn: () =>
    expectMigrationAbort(
      [{
        username: "sparkless",
        nostrPubkey: NPUB,
        connectionSecret: "secret-sparkless",
        destination: "spark",
        sparkIdentityPubkey: null,
      }],
      "secret-sparkless",
      SPARK_KEY,
    ),
});

Deno.test({
  name: "usernames that collide when lowercased abort 0004",
  ignore: !databaseUrl,
  fn: () =>
    expectMigrationAbort(
      [
        {
          username: "Alice",
          nostrPubkey: NPUB,
          connectionSecret: "secret-alice-1",
          destination: null,
          sparkIdentityPubkey: null,
        },
        {
          username: "alice",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: "secret-alice-2",
          destination: null,
          sparkIdentityPubkey: null,
        },
      ],
      "secret-alice-1",
      SPARK_KEY,
    ),
});

Deno.test({
  name: "the same nostr pubkey on two rows aborts 0004",
  ignore: !databaseUrl,
  fn: () =>
    expectMigrationAbort(
      [
        {
          username: "one",
          nostrPubkey: NPUB_UPPER_SAME(),
          connectionSecret: "secret-one",
          destination: null,
          sparkIdentityPubkey: null,
        },
        {
          username: "two",
          nostrPubkey: NPUB,
          connectionSecret: "secret-two",
          destination: null,
          sparkIdentityPubkey: null,
        },
      ],
      "secret-one",
      SPARK_KEY,
    ),
});

Deno.test({
  name: "the same spark key on two rows aborts 0004",
  ignore: !databaseUrl,
  fn: () =>
    expectMigrationAbort(
      [
        {
          username: "spark-a",
          nostrPubkey: NPUB,
          connectionSecret: null,
          destination: "spark",
          sparkIdentityPubkey: SPARK_KEY_UPPER,
        },
        {
          username: "spark-b",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: null,
          destination: "spark",
          sparkIdentityPubkey: SPARK_KEY,
        },
      ],
      "secret-one",
      SPARK_KEY,
    ),
});

Deno.test({
  name: "two empty nostr pubkeys do not abort 0004",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (sql) => {
      await applyNamed(sql, THROUGH_0003);
      await insertUser(sql, {
        username: "blank-a",
        nostrPubkey: "",
        connectionSecret: "secret-blank-a",
        destination: null,
        sparkIdentityPubkey: null,
      });
      await insertUser(sql, {
        username: "blank-b",
        nostrPubkey: "",
        connectionSecret: "secret-blank-b",
        destination: null,
        sparkIdentityPubkey: null,
      });
      await applyNamed(sql, [MIGRATION_0004]);
      const rows = await sql<{ username: string; nostr_pubkey: string; destination: string }[]>`
        select username, nostr_pubkey, destination from users order by username
      `;
      expect(rows).toEqual([
        { username: "blank-a", nostr_pubkey: "", destination: "nwc" },
        { username: "blank-b", nostr_pubkey: "", destination: "nwc" },
      ]);
    });
  },
});

Deno.test({
  name: "0004 constraints reject illegal users, intents, and invoice provenance",
  ignore: !databaseUrl,
  async fn() {
    await withDatabase(async (sql) => {
      await applyNamed(sql, [...THROUGH_0003, MIGRATION_0004]);
      const userId = await insertUser(sql, {
        username: "keeper",
        nostrPubkey: NPUB,
        connectionSecret: "secret-keeper",
        destination: "nwc",
        sparkIdentityPubkey: null,
      });

      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "both",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: "secret-both",
          destination: "nwc",
          sparkIdentityPubkey: SPARK_KEY,
        }));
      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "neither",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: null,
          destination: "nwc",
          sparkIdentityPubkey: null,
        }));
      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "disagree",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: null,
          destination: "nwc",
          sparkIdentityPubkey: SPARK_KEY,
        }));
      await expectSqlState(sql, "23502", () =>
        insertUser(sql, {
          username: "nulldest",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: "secret-null",
          destination: null,
          sparkIdentityPubkey: null,
        }));
      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "lightning",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: "secret-light",
          destination: "lightning",
          sparkIdentityPubkey: null,
        }));
      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "upperkey",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: null,
          destination: "spark",
          sparkIdentityPubkey: SPARK_KEY_UPPER,
        }));
      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "oddkey",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: null,
          destination: "spark",
          sparkIdentityPubkey: SPARK_KEY_04,
        }));
      await expectSqlState(sql, "23514", () =>
        insertUser(sql, {
          username: "Alice",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: "secret-alice",
          destination: "nwc",
          sparkIdentityPubkey: null,
        }));
      await expectSqlState(sql, "23505", () =>
        insertUser(sql, {
          username: "second-npub",
          nostrPubkey: NPUB,
          connectionSecret: "secret-second",
          destination: "nwc",
          sparkIdentityPubkey: null,
        }));
      await insertUser(sql, {
        username: "spark-holder",
        nostrPubkey: NPUB_THIRD,
        connectionSecret: null,
        destination: "spark",
        sparkIdentityPubkey: SPARK_KEY,
      });
      await expectSqlState(sql, "23505", () =>
        insertUser(sql, {
          username: "spark-copy",
          nostrPubkey: NPUB_OTHER,
          connectionSecret: null,
          destination: "spark",
          sparkIdentityPubkey: SPARK_KEY,
        }));

      await sql`
        insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
        values ('intent', ${NPUB}, ${SPARK_KEY_OTHER}, now())
      `;
      await expectSqlState(sql, "23514", () =>
        sql`
          insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
          values ('Intent', ${NPUB_OTHER}, ${SPARK_KEY_OTHER}, now())
        `);
      await expectSqlState(sql, "23514", () =>
        sql`
          insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
          values ('badkey', ${NPUB_OTHER}, ${SPARK_KEY_04}, now())
        `);
      await expectSqlState(sql, "23505", () =>
        sql`
          insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
          values ('intent', ${NPUB_OTHER}, ${SPARK_KEY}, now())
        `);

      await expectSqlState(sql, "23514", () =>
        sql`
          insert into invoices (
            user_id, amount, payment_request, payment_hash, minted_by, receiver_pubkey
          ) values (
            ${userId}, 1, 'pr-spark-null', 'hash-spark-null', 'spark', null
          )
        `);
      await expectSqlState(sql, "23514", () =>
        sql`
          insert into invoices (
            user_id, amount, payment_request, payment_hash, minted_by, receiver_pubkey
          ) values (
            ${userId}, 1, 'pr-nwc-recv', 'hash-nwc-recv', 'nwc', ${SPARK_KEY}
          )
        `);
      await expectSqlState(sql, "23502", () =>
        sql`
          insert into invoices (
            user_id, amount, payment_request, payment_hash, minted_by, receiver_pubkey
          ) values (
            ${userId}, 1, 'pr-null-mint', 'hash-null-mint', null, null
          )
        `);
      await expectSqlState(sql, "23514", () =>
        sql`
          insert into invoices (
            user_id, amount, payment_request, payment_hash, minted_by, receiver_pubkey
          ) values (
            ${userId}, 1, 'pr-other', 'hash-other', 'other', null
          )
        `);
    });
  },
});

function NPUB_UPPER_SAME(): string {
  return "11".repeat(32).toUpperCase();
}

Deno.test({
  name: "createUser stores destination nwc and lowercases username and npub",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDatabase(async (sql, url) => {
      await applyNamed(sql, [...THROUGH_0003, MIGRATION_0004]);
      Deno.env.set("DATABASE_URL", url);
      Deno.env.set("BASE_URL", "http://lnaddr.test");
      Deno.env.set("ENCRYPTION_KEY", ZERO_KEY);
      const { DB: Repository } = await import("./db.ts");
      const db = new Repository(url);
      const result = await db.createUser({
        npubHex: "AB".repeat(32),
        username: "Alice",
        encryptedSecret: "enc-alice",
        now: NOW,
      });
      if (result.kind !== "created") throw new Error("expected created");
      const created = result.user;
      const rows = await sql<{
        username: string;
        nostr_pubkey: string;
        destination: string | null;
      }[]>`
        select username, nostr_pubkey, destination
        from users
        where id = ${created.id}
      `;
      expect(rows[0].username).toBe("alice");
      expect(rows[0].nostr_pubkey).toBe("ab".repeat(32));
      expect(rows[0].destination).toBe("nwc");

      const sparkId = await insertUser(sql, {
        username: "spark-recv",
        nostrPubkey: NPUB_OTHER,
        connectionSecret: null,
        destination: "spark",
        sparkIdentityPubkey: SPARK_KEY,
      });
      const nwcTx = {
        amount: 1000,
        description: "nwc",
        invoice: "pr-repo-nwc",
        payment_hash: "hash-repo-nwc",
      };
      const sparkTx = {
        amount: 2000,
        description: "spark",
        invoice: "pr-repo-spark",
        payment_hash: "hash-repo-spark",
      };
      await db.createInvoice(created.id, nwcTx as never, { by: "nwc" });
      await db.createInvoice(sparkId, sparkTx as never, {
        by: "spark",
        receiverPubkey: SPARK_KEY,
      });
      const stored = await sql<{
        payment_hash: string;
        minted_by: string;
        receiver_pubkey: string | null;
        preimage: string | null;
      }[]>`
        select payment_hash, minted_by, receiver_pubkey, preimage
        from invoices
        order by payment_hash
      `;
      expect(stored).toEqual([
        {
          payment_hash: "hash-repo-nwc",
          minted_by: "nwc",
          receiver_pubkey: null,
          preimage: null,
        },
        {
          payment_hash: "hash-repo-spark",
          minted_by: "spark",
          receiver_pubkey: SPARK_KEY,
          preimage: null,
        },
      ]);

      const first = await db.settleSparkInvoice("hash-repo-spark", "ab".repeat(32));
      const settled = await sql<{ preimage: string | null; settled_at: Date | null }[]>`
        select preimage, settled_at from invoices where payment_hash = 'hash-repo-spark'
      `;
      const second = await db.settleSparkInvoice("hash-repo-spark", "cd".repeat(32));
      const again = await sql<{ preimage: string | null; settled_at: Date | null }[]>`
        select preimage, settled_at from invoices where payment_hash = 'hash-repo-spark'
      `;
      expect(first).toBe("settled");
      expect(second).toBe("already_settled");
      expect(again[0].preimage).toBe(settled[0].preimage);
      expect(again[0].settled_at?.toISOString()).toBe(settled[0].settled_at?.toISOString());

      const ignored = await db.settleSparkInvoice("hash-repo-nwc", "ef".repeat(32));
      const nwcRow = await sql<{ preimage: string | null; settled_at: Date | null }[]>`
        select preimage, settled_at from invoices where payment_hash = 'hash-repo-nwc'
      `;
      expect(ignored).toBe("already_settled");
      expect(nwcRow[0].preimage).toBeNull();
      expect(nwcRow[0].settled_at).toBeNull();

      await db.markInvoiceSettled(sparkId, {
        payment_hash: "hash-repo-spark",
        preimage: "11".repeat(32),
        settled_at: 1_700_000_000,
      } as never);
      const sparkUntouched = await sql<{ preimage: string | null }[]>`
        select preimage from invoices where payment_hash = 'hash-repo-spark'
      `;
      expect(sparkUntouched[0].preimage).toBe("ab".repeat(32));

      await db.markInvoiceSettled(created.id, {
        payment_hash: "hash-repo-nwc",
        preimage: "22".repeat(32),
        settled_at: 1_700_000_100,
      } as never);
      await db.markInvoiceSettled(created.id, {
        payment_hash: "hash-repo-nwc",
        preimage: "33".repeat(32),
        settled_at: 1_700_000_200,
      } as never);
      const nwcSettled = await sql<{ preimage: string | null }[]>`
        select preimage from invoices where payment_hash = 'hash-repo-nwc'
      `;
      expect(nwcSettled[0].preimage).toBe("22".repeat(32));
      await db.close();
    });
  },
});

Deno.test({
  name: "manual rollback of 0004 restores the pre-0004 shape and keeps rows",
  ignore: !databaseUrl,
  async fn() {
    const journal = await Deno.readTextFile(new URL("../../drizzle/meta/_journal.json", import.meta.url));
    expect(journal.includes("0004_down")).toBe(false);
    await withDatabase(async (sql) => {
      await applyNamed(sql, THROUGH_0003);
      const userId = await insertUser(sql, {
        username: "bob",
        nostrPubkey: NPUB,
        connectionSecret: "secret-bob",
        destination: null,
        sparkIdentityPubkey: null,
      });
      await sql`
        insert into invoices (user_id, amount, payment_request, payment_hash)
        values (${userId}, 1000, 'pr-bob', 'hash-bob')
      `;
      await applyNamed(sql, [MIGRATION_0004]);
      const before = await sql<{
        username: string;
        destination: string;
        nostr_pubkey: string;
        payment_hash: string;
        minted_by: string;
      }[]>`
        select u.username, u.destination, u.nostr_pubkey, i.payment_hash, i.minted_by
        from users u
        join invoices i on i.user_id = u.id
      `;
      const script = await Deno.readTextFile(
        new URL("../../drizzle/rollback/0004_down.sql", import.meta.url),
      );
      await applySql(sql, script);

      const constraints = await sql<{ conname: string }[]>`
        select conname from pg_constraint
        where conname in (
          'users_destination_xor',
          'users_spark_pubkey_format',
          'users_username_lowercase',
          'invoices_minted_by_receiver'
        )
      `;
      const indexes = await sql<{ indexname: string }[]>`
        select indexname from pg_indexes
        where indexname in ('users_nostr_pubkey_unique', 'users_spark_identity_pubkey_unique')
      `;
      const nullability = await sql<{ table_name: string; column_name: string; is_nullable: string }[]>`
        select table_name, column_name, is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'users' and column_name = 'destination')
            or (table_name = 'invoices' and column_name = 'minted_by')
          )
        order by table_name, column_name
      `;
      const [rebindCount] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from ${REBIND_TABLE}`,
      );
      const after = await sql<{
        username: string;
        destination: string;
        nostr_pubkey: string;
        payment_hash: string;
        minted_by: string;
      }[]>`
        select u.username, u.destination, u.nostr_pubkey, i.payment_hash, i.minted_by
        from users u
        join invoices i on i.user_id = u.id
      `;
      expect(constraints).toEqual([]);
      expect(indexes).toEqual([]);
      expect(nullability).toEqual([
        { table_name: "invoices", column_name: "minted_by", is_nullable: "YES" },
        { table_name: "users", column_name: "destination", is_nullable: "YES" },
      ]);
      expect(rebindCount.count).toBe("0");
      expect(after).toEqual(before);
    });
  },
});

// ---------------------------------------------------------------------------
// Account repository (L4): binding intents, NWC create and bind, abandon.
// Every test runs on a fresh database migrated through 0004 and opens the
// repository against that database with an injected clock.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T12:00:00.000Z");
const INTENT_TTL_MS = 600 * 1000;
const SPARK_KEY_THIRD = "02" + "ef".repeat(32);

function secondsFrom(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1000);
}

type RepoContext = { sql: Sql; db: DB; url: string };

async function withRepo(fn: (ctx: RepoContext) => Promise<void>): Promise<void> {
  await withDatabase(async (sql, url) => {
    await applyNamed(sql, [...THROUGH_0003, MIGRATION_0004]);
    Deno.env.set("DATABASE_URL", url);
    Deno.env.set("BASE_URL", "http://lnaddr.test");
    Deno.env.set("ENCRYPTION_KEY", ZERO_KEY);
    const { DB: Repository } = await import("./db.ts");
    const db = new Repository(url);
    try {
      await fn({ sql, db, url });
    } finally {
      await db.close();
    }
  });
}

async function seedNwc(sql: Sql, username: string, nostrPubkey: string): Promise<number> {
  return await insertUser(sql, {
    username,
    nostrPubkey,
    connectionSecret: `enc-${username}`,
    destination: "nwc",
    sparkIdentityPubkey: null,
  });
}

async function seedSpark(
  sql: Sql,
  username: string,
  nostrPubkey: string,
  sparkIdentityPubkey: string,
): Promise<number> {
  return await insertUser(sql, {
    username,
    nostrPubkey,
    connectionSecret: null,
    destination: "spark",
    sparkIdentityPubkey,
  });
}

async function seedIntent(
  sql: Sql,
  intent: { username: string; nostrPubkey: string; sparkPubkey: string; expiresAt: Date },
): Promise<void> {
  await sql`
    insert into binding_intents (username, nostr_pubkey, spark_pubkey, expires_at)
    values (${intent.username}, ${intent.nostrPubkey}, ${intent.sparkPubkey}, ${intent.expiresAt})
  `;
}

type IntentRow = {
  username: string;
  nostr_pubkey: string;
  spark_pubkey: string;
  expires_at: Date;
};

async function allIntents(sql: Sql): Promise<IntentRow[]> {
  return await sql<IntentRow[]>`
    select username, nostr_pubkey, spark_pubkey, expires_at
    from binding_intents
    order by username
  `;
}

async function userSnapshot(sql: Sql) {
  return await sql`select * from users order by id`;
}

Deno.test({
  name: "findUserByNostrPubkey and findUserBySparkPubkey return the account row or null",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const nwcId = await seedNwc(sql, "alice", NPUB);
      const sparkId = await seedSpark(sql, "bob", NPUB_OTHER, SPARK_KEY);

      expect(await db.findUserByNostrPubkey(NPUB)).toEqual({
        id: nwcId,
        username: "alice",
        nostrPubkey: NPUB,
        destination: "nwc",
        sparkIdentityPubkey: null,
        encryptedConnectionSecret: "enc-alice",
      });
      expect(await db.findUserBySparkPubkey(SPARK_KEY)).toEqual({
        id: sparkId,
        username: "bob",
        nostrPubkey: NPUB_OTHER,
        destination: "spark",
        sparkIdentityPubkey: SPARK_KEY,
        encryptedConnectionSecret: null,
      });
      expect(await db.findUserByNostrPubkey(NPUB_THIRD)).toBeNull();
      expect(await db.findUserBySparkPubkey(SPARK_KEY_OTHER)).toBeNull();
    });
  },
});

Deno.test({
  name: "createBindingIntent on a free name stores the intent for 600 seconds and leaves users untouched",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "bob", NPUB_OTHER);
      const before = await userSnapshot(sql);

      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });

      const expected = new Date(NOW.getTime() + INTENT_TTL_MS);
      expect(result).toEqual({ kind: "ok", expiresAt: expected });
      expect(await allIntents(sql)).toEqual([
        { username: "alice", nostr_pubkey: NPUB, spark_pubkey: SPARK_KEY, expires_at: expected },
      ]);
      expect(await userSnapshot(sql)).toEqual(before);
    });
  },
});

Deno.test({
  name: "createBindingIntent lets the account switch its own NWC row without changing it",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "alice", NPUB);
      const before = await userSnapshot(sql);

      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });

      expect(result.kind).toBe("ok");
      expect((await allIntents(sql)).map((row) => row.username)).toEqual(["alice"]);
      expect(await userSnapshot(sql)).toEqual(before);
    });
  },
});

Deno.test({
  name: "createBindingIntent applies each conflict row and leaves no intent behind",
  ignore: !databaseUrl,
  async fn() {
    // Row 1: the username belongs to another account.
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "alice", NPUB_OTHER);
      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });
      expect(result).toEqual({ kind: "conflict", reason: "name_taken" });
      expect(await allIntents(sql)).toEqual([]);
    });
    // Row 2: the account already holds a different username.
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "bob", NPUB);
      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });
      expect(result).toEqual({ kind: "conflict", reason: "account_username_differs" });
      expect(await allIntents(sql)).toEqual([]);
    });
    // Row 3: the Spark key is bound to another account.
    await withRepo(async ({ sql, db }) => {
      await seedSpark(sql, "carol", NPUB_OTHER, SPARK_KEY);
      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });
      expect(result).toEqual({ kind: "conflict", reason: "pubkey_taken" });
      expect(await allIntents(sql)).toEqual([]);
    });
  },
});

Deno.test({
  name: "createBindingIntent answers name_in_progress for a foreign active intent and leaves it unchanged",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const foreignExpiry = secondsFrom(NOW, 120);
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: foreignExpiry,
      });

      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });

      expect(result).toEqual({ kind: "conflict", reason: "name_in_progress" });
      expect(await allIntents(sql)).toEqual([
        {
          username: "alice",
          nostr_pubkey: NPUB_OTHER,
          spark_pubkey: SPARK_KEY_OTHER,
          expires_at: foreignExpiry,
        },
      ]);
    });
  },
});

Deno.test({
  name: "createBindingIntent ignores and prunes expired intents",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: secondsFrom(NOW, -1),
      });
      await seedIntent(sql, {
        username: "stale-one",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY_THIRD,
        expiresAt: secondsFrom(NOW, -3600),
      });
      await seedIntent(sql, {
        username: "live",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY_THIRD,
        expiresAt: secondsFrom(NOW, 90),
      });

      const result = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });

      expect(result.kind).toBe("ok");
      // The expired foreign intent for alice was replaced, the second expired
      // intent was pruned, and the unrelated active intent survives.
      expect((await allIntents(sql)).map((row) => [row.username, row.nostr_pubkey])).toEqual([
        ["alice", NPUB],
        ["live", NPUB_THIRD],
      ]);
    });
  },
});

Deno.test({
  name: "createBindingIntent keeps one precedence: name_taken, differs, pubkey_taken, in_progress",
  ignore: !databaseUrl,
  async fn() {
    // name_taken beats account_username_differs.
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "bob", NPUB);
      await seedNwc(sql, "alice", NPUB_OTHER);
      expect(
        await db.createBindingIntent({
          npubHex: NPUB,
          username: "alice",
          sparkPubkey: SPARK_KEY,
          now: NOW,
        }),
      ).toEqual({ kind: "conflict", reason: "name_taken" });
    });
    // account_username_differs (row 2) beats pubkey_taken (row 3) and
    // name_in_progress (row 4).
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "alice", NPUB);
      await seedSpark(sql, "mallory", NPUB_OTHER, SPARK_KEY);
      await seedIntent(sql, {
        username: "carol",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY_THIRD,
        expiresAt: secondsFrom(NOW, 300),
      });
      expect(
        await db.createBindingIntent({
          npubHex: NPUB,
          username: "carol",
          sparkPubkey: SPARK_KEY,
          now: NOW,
        }),
      ).toEqual({ kind: "conflict", reason: "account_username_differs" });
    });
    // With no row for the account, pubkey_taken (row 3) beats name_in_progress (row 4).
    await withRepo(async ({ sql, db }) => {
      await seedSpark(sql, "mallory", NPUB_OTHER, SPARK_KEY);
      await seedIntent(sql, {
        username: "carol",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY_THIRD,
        expiresAt: secondsFrom(NOW, 300),
      });
      expect(
        await db.createBindingIntent({
          npubHex: NPUB,
          username: "carol",
          sparkPubkey: SPARK_KEY,
          now: NOW,
        }),
      ).toEqual({ kind: "conflict", reason: "pubkey_taken" });
    });
  },
});

Deno.test({
  name: "createBindingIntent keeps one active intent per account and per username",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const first = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });
      expect(first.kind).toBe("ok");

      // Same npub, same username: key replaced, expiry renewed.
      const later = secondsFrom(NOW, 100);
      const renewed = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY_OTHER,
        now: later,
      });
      const renewedExpiry = new Date(later.getTime() + INTENT_TTL_MS);
      expect(renewed).toEqual({ kind: "ok", expiresAt: renewedExpiry });
      expect(await allIntents(sql)).toEqual([
        {
          username: "alice",
          nostr_pubkey: NPUB,
          spark_pubkey: SPARK_KEY_OTHER,
          expires_at: renewedExpiry,
        },
      ]);

      // Same npub, another username: the previous intent is dropped.
      const second = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice-two",
        sparkPubkey: SPARK_KEY_OTHER,
        now: later,
      });
      expect(second.kind).toBe("ok");
      expect((await allIntents(sql)).map((row) => row.username)).toEqual(["alice-two"]);

      // Another npub cannot displace an active intent.
      const foreign = await db.createBindingIntent({
        npubHex: NPUB_OTHER,
        username: "alice-two",
        sparkPubkey: SPARK_KEY,
        now: later,
      });
      expect(foreign).toEqual({ kind: "conflict", reason: "name_in_progress" });
      expect((await allIntents(sql)).map((row) => row.nostr_pubkey)).toEqual([NPUB]);
    });
  },
});

Deno.test({
  name: "createBindingIntent concurrent requests from two accounts leave exactly one intent",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const [a, b] = await Promise.all([
        db.createBindingIntent({
          npubHex: NPUB,
          username: "alice",
          sparkPubkey: SPARK_KEY,
          now: NOW,
        }),
        db.createBindingIntent({
          npubHex: NPUB_OTHER,
          username: "alice",
          sparkPubkey: SPARK_KEY_OTHER,
          now: NOW,
        }),
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["conflict", "ok"]);
      const rows = await allIntents(sql);
      expect(rows.length).toBe(1);
      const winner = a.kind === "ok" ? NPUB : NPUB_OTHER;
      expect(rows[0].nostr_pubkey).toBe(winner);
    });
  },
});

function createInput(
  overrides: Partial<{ npubHex: string; username: string; encryptedSecret: string; now: Date }> = {},
) {
  return {
    npubHex: NPUB,
    username: "alice",
    encryptedSecret: "enc-new",
    now: NOW,
    ...overrides,
  };
}

Deno.test({
  name: "createUser stores a lowercase NWC row and reports the new account",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const result = await db.createUser(
        createInput({ npubHex: "AB".repeat(32), username: "Alice", encryptedSecret: "enc-alice" }),
      );
      if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
      expect(result.user).toEqual({
        id: result.user.id,
        username: "alice",
        nostrPubkey: "ab".repeat(32),
        destination: "nwc",
        sparkIdentityPubkey: null,
        encryptedConnectionSecret: "enc-alice",
      });
      const [stored] = await sql<{ username: string; nostr_pubkey: string; destination: string }[]>`
        select username, nostr_pubkey, destination from users where id = ${result.user.id}
      `;
      expect(stored).toEqual({
        username: "alice",
        nostr_pubkey: "ab".repeat(32),
        destination: "nwc",
      });
    });
  },
});

Deno.test({
  name: "createUser conflicts follow username_taken, account_exists, name_in_progress",
  ignore: !databaseUrl,
  async fn() {
    // All three apply: the username is taken, the npub has a row, and a foreign intent exists.
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "alice", NPUB_OTHER);
      await seedNwc(sql, "bob", NPUB);
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY,
        expiresAt: secondsFrom(NOW, 300),
      });
      expect(await db.createUser(createInput({ username: "alice" }))).toEqual({
        kind: "conflict",
        reason: "username_taken",
      });
      const rows = await sql`select 1 from users`;
      expect(rows.length).toBe(2);
    });
    // The npub has a row and a foreign intent exists for the new name.
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "bob", NPUB);
      await seedIntent(sql, {
        username: "carol",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY,
        expiresAt: secondsFrom(NOW, 300),
      });
      expect(await db.createUser(createInput({ username: "carol" }))).toEqual({
        kind: "conflict",
        reason: "account_exists",
      });
    });
    // Only the foreign intent applies.
    await withRepo(async ({ sql, db }) => {
      await seedIntent(sql, {
        username: "carol",
        nostrPubkey: NPUB_THIRD,
        sparkPubkey: SPARK_KEY,
        expiresAt: secondsFrom(NOW, 300),
      });
      expect(await db.createUser(createInput({ username: "carol" }))).toEqual({
        kind: "conflict",
        reason: "name_in_progress",
      });
      expect((await sql`select 1 from users`).length).toBe(0);
      expect((await allIntents(sql)).length).toBe(1);
    });
  },
});

Deno.test({
  name: "createUser is not blocked by the account's own intent or by an expired foreign one",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB,
        sparkPubkey: SPARK_KEY,
        expiresAt: secondsFrom(NOW, 300),
      });
      const own = await db.createUser(createInput({ username: "alice" }));
      expect(own.kind).toBe("created");
    });
    await withRepo(async ({ sql, db }) => {
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY,
        expiresAt: secondsFrom(NOW, -1),
      });
      const expired = await db.createUser(createInput({ username: "alice" }));
      expect(expired.kind).toBe("created");
    });
  },
});

Deno.test({
  name: "createUser maps concurrent unique violations to conflicts instead of errors",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const sameName = await Promise.all([
        db.createUser(createInput({ npubHex: NPUB, username: "alice" })),
        db.createUser(createInput({ npubHex: NPUB_OTHER, username: "alice" })),
      ]);
      expect(sameName.map((result) => result.kind).sort()).toEqual(["conflict", "created"]);
      const nameLoser = sameName.find((result) => result.kind === "conflict");
      expect(nameLoser).toEqual({ kind: "conflict", reason: "username_taken" });

      const sameAccount = await Promise.all([
        db.createUser(createInput({ npubHex: NPUB_THIRD, username: "carol" })),
        db.createUser(createInput({ npubHex: NPUB_THIRD, username: "dave" })),
      ]);
      expect(sameAccount.map((result) => result.kind).sort()).toEqual(["conflict", "created"]);
      const accountLoser = sameAccount.find((result) => result.kind === "conflict");
      expect(accountLoser).toEqual({ kind: "conflict", reason: "account_exists" });
      expect((await sql`select 1 from users`).length).toBe(2);
    });
  },
});

Deno.test({
  name: "bindNwcDestination moves a Spark row to NWC in place with an encrypted secret",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const id = await seedSpark(sql, "alice", NPUB, SPARK_KEY);
      const [before] = await sql<{ created_at: Date }[]>`select created_at from users where id = ${id}`;
      const { encrypt, decrypt } = await import("./aesgcm.ts");
      const ciphertext = await encrypt(NWC_URL);

      const result = await db.bindNwcDestination(NPUB, ciphertext, NOW);

      if (result.kind !== "bound") throw new Error(`expected bound, got ${result.kind}`);
      expect(result.user.id).toBe(id);
      expect(result.user.username).toBe("alice");
      expect(result.user.destination).toBe("nwc");
      expect(result.user.sparkIdentityPubkey).toBeNull();
      const [row] = await sql<{
        connection_secret: string;
        spark_identity_pubkey: string | null;
        destination: string;
        created_at: Date;
      }[]>`select connection_secret, spark_identity_pubkey, destination, created_at from users where id = ${id}`;
      expect(row.destination).toBe("nwc");
      expect(row.spark_identity_pubkey).toBeNull();
      expect(row.created_at).toEqual(before.created_at);
      expect(row.connection_secret).not.toBe(NWC_URL);
      expect(await decrypt(row.connection_secret)).toBe(NWC_URL);
    });
  },
});

Deno.test({
  name: "bindNwcDestination replaces the secret of an NWC row and reports not_found without a row",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const id = await seedNwc(sql, "alice", NPUB);
      const replaced = await db.bindNwcDestination(NPUB, "enc-replaced", NOW);
      if (replaced.kind !== "bound") throw new Error(`expected bound, got ${replaced.kind}`);
      expect(replaced.user.id).toBe(id);
      const [row] = await sql<{ connection_secret: string }[]>`
        select connection_secret from users where id = ${id}
      `;
      expect(row.connection_secret).toBe("enc-replaced");

      expect(await db.bindNwcDestination(NPUB_OTHER, "enc-x", NOW)).toEqual({ kind: "not_found" });
      expect((await sql`select 1 from users`).length).toBe(1);
    });
  },
});

Deno.test({
  name: "bindNwcDestination refuses a foreign active intent on the row's username and allows its own",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedSpark(sql, "alice", NPUB, SPARK_KEY);
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: secondsFrom(NOW, 300),
      });
      expect(await db.bindNwcDestination(NPUB, "enc-x", NOW)).toEqual({
        kind: "conflict",
        reason: "name_in_progress",
      });
      const [unchanged] = await sql<{ destination: string }[]>`select destination from users`;
      expect(unchanged.destination).toBe("spark");
    });
    await withRepo(async ({ sql, db }) => {
      await seedSpark(sql, "alice", NPUB, SPARK_KEY);
      await seedIntent(sql, {
        username: "alice",
        nostrPubkey: NPUB,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: secondsFrom(NOW, 300),
      });
      const own = await db.bindNwcDestination(NPUB, "enc-x", NOW);
      expect(own.kind).toBe("bound");
    });
  },
});

Deno.test({
  name: "deleteUserByNostrPubkey removes the account, its invoices and intents, and nothing else",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const doomed = await seedNwc(sql, "alice", NPUB);
      const survivor = await seedNwc(sql, "bob", NPUB_OTHER);
      await sql`
        insert into invoices (user_id, amount, payment_request, payment_hash, minted_by)
        values (${doomed}, 1000, 'pr-doomed', 'hash-doomed', 'nwc'),
               (${survivor}, 1000, 'pr-survivor', 'hash-survivor', 'nwc')
      `;
      await seedIntent(sql, {
        username: "carol",
        nostrPubkey: NPUB,
        sparkPubkey: SPARK_KEY,
        expiresAt: secondsFrom(NOW, 300),
      });
      await seedIntent(sql, {
        username: "dave",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: secondsFrom(NOW, 300),
      });

      expect(await db.deleteUserByNostrPubkey(NPUB)).toBe(1);

      expect((await sql<{ username: string }[]>`select username from users`).map((r) => r.username))
        .toEqual(["bob"]);
      expect((await sql<{ payment_hash: string }[]>`select payment_hash from invoices`).map((r) =>
        r.payment_hash
      )).toEqual(["hash-survivor"]);
      expect((await allIntents(sql)).map((row) => row.username)).toEqual(["dave"]);

      expect(await db.deleteUserByNostrPubkey(NPUB)).toBe(0);
      expect((await sql`select 1 from users`).length).toBe(1);
    });
  },
});

Deno.test({
  name: "deleteUserByNostrPubkey never matches legacy rows with an empty npub",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "legacy-one", "");
      await seedNwc(sql, "legacy-two", "");
      expect(await db.deleteUserByNostrPubkey("")).toBe(0);
      expect((await sql`select 1 from users`).length).toBe(2);
    });
  },
});

// ---------------------------------------------------------------------------
// registerSparkAddress (L5): intent -> claim -> rows -> consume, one transaction.
// ---------------------------------------------------------------------------

const REGISTER_TS = Math.floor(NOW.getTime() / 1000);

function registerInput(
  overrides: Partial<{
    username: string;
    sparkPubkey: string;
    hash: string;
    ts: number;
    now: Date;
  }> = {},
) {
  const ts = overrides.ts ?? REGISTER_TS;
  return {
    username: overrides.username ?? "alice",
    sparkPubkey: overrides.sparkPubkey ?? SPARK_KEY,
    statement: {
      hash: overrides.hash ?? "hash-one",
      route: "register" as const,
      expiresAt: new Date((ts + 600) * 1000),
    },
    now: overrides.now ?? NOW,
  };
}

async function claimRows(sql: Sql): Promise<{ statement_hash: string; expires_at: Date }[]> {
  return await sql<{ statement_hash: string; expires_at: Date }[]>`
    select statement_hash, expires_at from signed_statements order by statement_hash
  `;
}

async function installUserWriteFailure(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create function fail_users_write() returns trigger language plpgsql as $$
    begin raise exception 'injected failure'; end $$
  `);
  await sql.unsafe(`
    create trigger fail_users_write before insert or update on users
    for each row execute function fail_users_write()
  `);
}

async function clearUserWriteFailure(sql: Sql): Promise<void> {
  await sql.unsafe("drop trigger fail_users_write on users");
}

async function seedActiveIntent(
  sql: Sql,
  overrides: Partial<{ username: string; nostrPubkey: string; sparkPubkey: string; expiresAt: Date }> = {},
): Promise<void> {
  await seedIntent(sql, {
    username: overrides.username ?? "alice",
    nostrPubkey: overrides.nostrPubkey ?? NPUB,
    sparkPubkey: overrides.sparkPubkey ?? SPARK_KEY,
    expiresAt: overrides.expiresAt ?? secondsFrom(NOW, 300),
  });
}

Deno.test({
  name: "registerSparkAddress answers no_intent without a claim or a row",
  ignore: !databaseUrl,
  async fn() {
    // No intent at all.
    await withRepo(async ({ sql, db }) => {
      expect(await db.registerSparkAddress(registerInput())).toEqual({ kind: "no_intent" });
      expect(await claimRows(sql)).toEqual([]);
      expect((await sql`select 1 from users`).length).toBe(0);
    });
    // The intent expired one second ago.
    await withRepo(async ({ sql, db }) => {
      await seedActiveIntent(sql, { expiresAt: secondsFrom(NOW, -1) });
      expect(await db.registerSparkAddress(registerInput())).toEqual({ kind: "no_intent" });
      expect(await claimRows(sql)).toEqual([]);
      expect((await sql`select 1 from users`).length).toBe(0);
    });
    // The intent names another key and stays untouched.
    await withRepo(async ({ sql, db }) => {
      await seedActiveIntent(sql, { sparkPubkey: SPARK_KEY_OTHER });
      const before = await allIntents(sql);
      expect(await db.registerSparkAddress(registerInput())).toEqual({ kind: "no_intent" });
      expect(await allIntents(sql)).toEqual(before);
      expect(await claimRows(sql)).toEqual([]);
      expect((await sql`select 1 from users`).length).toBe(0);
    });
  },
});

Deno.test({
  name: "registerSparkAddress rolls back every conflict: intent stays, no claim, no row change",
  ignore: !databaseUrl,
  async fn() {
    const cases: Array<{
      name: string;
      seed: (sql: Sql) => Promise<void>;
      reason: string;
    }> = [
      {
        name: "row 1 name_taken",
        seed: async (sql) => {
          await seedNwc(sql, "alice", NPUB_OTHER);
        },
        reason: "name_taken",
      },
      {
        name: "row 2 account_username_differs",
        seed: async (sql) => {
          await seedNwc(sql, "bob", NPUB);
        },
        reason: "account_username_differs",
      },
      {
        name: "row 3 pubkey_taken",
        seed: async (sql) => {
          await seedSpark(sql, "carol", NPUB_OTHER, SPARK_KEY);
        },
        reason: "pubkey_taken",
      },
      {
        name: "all three rows apply: name_taken wins",
        seed: async (sql) => {
          await seedNwc(sql, "alice", NPUB_OTHER);
          await seedNwc(sql, "bob", NPUB);
          await seedSpark(sql, "carol", NPUB_THIRD, SPARK_KEY);
        },
        reason: "name_taken",
      },
      {
        name: "rows 2 and 3 apply: account_username_differs wins",
        seed: async (sql) => {
          await seedNwc(sql, "bob", NPUB);
          await seedSpark(sql, "carol", NPUB_OTHER, SPARK_KEY);
        },
        reason: "account_username_differs",
      },
    ];
    for (const scenario of cases) {
      await withRepo(async ({ sql, db }) => {
        await scenario.seed(sql);
        await seedActiveIntent(sql);
        const usersBefore = await userSnapshot(sql);
        const intentsBefore = await allIntents(sql);

        const result = await db.registerSparkAddress(registerInput());

        expect(result).toEqual({ kind: "conflict", reason: scenario.reason as never });
        expect(await claimRows(sql)).toEqual([]);
        expect(await allIntents(sql)).toEqual(intentsBefore);
        expect(await userSnapshot(sql)).toEqual(usersBefore);
      });
    }
  },
});

Deno.test({
  name: "registerSparkAddress leaves the intent and no claim after an injected failure and succeeds on retry",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedActiveIntent(sql);
      await installUserWriteFailure(sql);

      let failed = false;
      try {
        await db.registerSparkAddress(registerInput());
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(await claimRows(sql)).toEqual([]);
      expect((await allIntents(sql)).length).toBe(1);
      expect((await sql`select 1 from users`).length).toBe(0);

      await clearUserWriteFailure(sql);
      const retried = await db.registerSparkAddress(registerInput());
      expect(retried.kind).toBe("created");
      expect((await claimRows(sql)).length).toBe(1);
    });
  },
});

Deno.test({
  name: "registerSparkAddress claims the statement until ts + 600 and refuses a replay",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedActiveIntent(sql);
      const first = await db.registerSparkAddress(registerInput());
      expect(first.kind).toBe("created");
      expect(await allIntents(sql)).toEqual([]);
      expect(await claimRows(sql)).toEqual([
        { statement_hash: "hash-one", expires_at: new Date((REGISTER_TS + 600) * 1000) },
      ]);

      // Replay without a new intent: nothing to bind.
      expect(await db.registerSparkAddress(registerInput())).toEqual({ kind: "no_intent" });
      expect((await claimRows(sql)).length).toBe(1);

      // Replay while a new intent exists: the statement is used, the intent remains.
      const renewed = await db.createBindingIntent({
        npubHex: NPUB,
        username: "alice",
        sparkPubkey: SPARK_KEY,
        now: NOW,
      });
      expect(renewed.kind).toBe("ok");
      expect(await db.registerSparkAddress(registerInput())).toEqual({
        kind: "conflict",
        reason: "statement_used",
      });
      expect((await allIntents(sql)).length).toBe(1);

      // A fresh timestamp is a new statement.
      const later = new Date(NOW.getTime() + 30_000);
      const fresh = await db.registerSparkAddress(
        registerInput({ hash: "hash-two", ts: REGISTER_TS + 30, now: later }),
      );
      expect(fresh.kind).toBe("unchanged");
      expect((await claimRows(sql)).map((row) => row.statement_hash)).toEqual([
        "hash-one",
        "hash-two",
      ]);
      expect(await allIntents(sql)).toEqual([]);
    });
  },
});

Deno.test({
  name: "registerSparkAddress prunes claims strictly before the clock and claims survive a new connection",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db, url }) => {
      await sql`
        insert into signed_statements (statement_hash, route, expires_at) values
          ('old', 'register', ${secondsFrom(NOW, -1)}),
          ('edge', 'register', ${NOW}),
          ('live', 'register', ${secondsFrom(NOW, 60)})
      `;
      await seedActiveIntent(sql);
      const result = await db.registerSparkAddress(registerInput({ hash: "hash-new" }));
      expect(result.kind).toBe("created");

      const other = postgres(url, { max: 1 });
      try {
        const rows = await other<{ statement_hash: string }[]>`
          select statement_hash from signed_statements order by statement_hash
        `;
        expect(rows.map((row) => row.statement_hash)).toEqual(["edge", "hash-new", "live"]);
      } finally {
        await other.end({ timeout: 5 });
      }
    });
  },
});

Deno.test({
  name: "registerSparkAddress takes the account npub from the intent",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedActiveIntent(sql, { nostrPubkey: NPUB_THIRD });
      const result = await db.registerSparkAddress(registerInput());
      if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
      expect(result.previous).toBeNull();
      expect(result.user.nostrPubkey).toBe(NPUB_THIRD);
      expect(result.user.destination).toBe("spark");
      expect(result.user.sparkIdentityPubkey).toBe(SPARK_KEY);
      expect(result.user.encryptedConnectionSecret).toBeNull();
      const rows = await sql<{ nostr_pubkey: string }[]>`select nostr_pubkey from users`;
      expect(rows).toEqual([{ nostr_pubkey: NPUB_THIRD }]);
    });
  },
});

Deno.test({
  name: "registerSparkAddress switches an NWC row in place and consumes the intent",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const id = await seedNwc(sql, "alice", NPUB);
      const [before] = await sql<{ created_at: Date }[]>`select created_at from users where id = ${id}`;
      await seedActiveIntent(sql);

      const result = await db.registerSparkAddress(registerInput());

      if (result.kind !== "switched") throw new Error(`expected switched, got ${result.kind}`);
      expect(result.previous).toBe("nwc");
      expect(result.user.id).toBe(id);
      const [row] = await sql<{
        username: string;
        destination: string;
        connection_secret: string | null;
        spark_identity_pubkey: string | null;
        created_at: Date;
      }[]>`select username, destination, connection_secret, spark_identity_pubkey, created_at from users`;
      expect(row).toEqual({
        username: "alice",
        destination: "spark",
        connection_secret: null,
        spark_identity_pubkey: SPARK_KEY,
        created_at: before.created_at,
      });
      expect(await allIntents(sql)).toEqual([]);
    });
  },
});

Deno.test({
  name: "registerSparkAddress is a no-op for the same key and rotates a different key keeping the row id",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const id = await seedSpark(sql, "alice", NPUB, SPARK_KEY);

      await seedActiveIntent(sql);
      const unchanged = await db.registerSparkAddress(registerInput({ hash: "h-unchanged" }));
      if (unchanged.kind !== "unchanged") throw new Error(`expected unchanged, got ${unchanged.kind}`);
      expect(unchanged.previous).toBe("spark");
      expect(unchanged.user.id).toBe(id);
      expect(await allIntents(sql)).toEqual([]);

      await seedActiveIntent(sql, { sparkPubkey: SPARK_KEY_OTHER });
      const rotated = await db.registerSparkAddress(
        registerInput({ hash: "h-rotated", sparkPubkey: SPARK_KEY_OTHER }),
      );
      if (rotated.kind !== "rotated") throw new Error(`expected rotated, got ${rotated.kind}`);
      expect(rotated.previous).toBe("spark");
      expect(rotated.user.id).toBe(id);
      expect(rotated.user.sparkIdentityPubkey).toBe(SPARK_KEY_OTHER);
      expect(await allIntents(sql)).toEqual([]);

      // Rotation needs an intent like any other register.
      expect(
        await db.registerSparkAddress(
          registerInput({ hash: "h-no-intent", sparkPubkey: SPARK_KEY_THIRD }),
        ),
      ).toEqual({ kind: "no_intent" });
      const [row] = await sql<{ spark_identity_pubkey: string }[]>`select spark_identity_pubkey from users`;
      expect(row.spark_identity_pubkey).toBe(SPARK_KEY_OTHER);
    });
  },
});

Deno.test({
  name: "two simultaneous identical registers give one success, one no_intent, and exactly one claim",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedActiveIntent(sql);
      const results = await Promise.all([
        db.registerSparkAddress(registerInput()),
        db.registerSparkAddress(registerInput()),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["created", "no_intent"]);
      expect((await claimRows(sql)).length).toBe(1);
      expect((await sql`select 1 from users`).length).toBe(1);
    });
  },
});

Deno.test({
  name: "a register and an NWC bind at the same time both succeed and the row keeps one credential",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "alice", NPUB);
      await seedActiveIntent(sql);
      const [registered, bound] = await Promise.all([
        db.registerSparkAddress(registerInput()),
        db.bindNwcDestination(NPUB, "enc-concurrent", NOW),
      ]);
      expect(registered.kind).toBe("switched");
      expect(bound.kind).toBe("bound");
      const rows = await sql<{
        destination: string;
        connection_secret: string | null;
        spark_identity_pubkey: string | null;
      }[]>`select destination, connection_secret, spark_identity_pubkey from users`;
      expect(rows.length).toBe(1);
      const [row] = rows;
      const credentials = [row.connection_secret, row.spark_identity_pubkey].filter((v) => v !== null);
      expect(credentials.length).toBe(1);
      expect(row.destination).toBe(row.connection_secret !== null ? "nwc" : "spark");
    });
  },
});

Deno.test({
  name: "NWC to Spark to NWC to Spark keeps one row, one address, and one credential at every step",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const id = await seedNwc(sql, "alice", NPUB);
      const [initial] = await sql<{ created_at: Date }[]>`select created_at from users where id = ${id}`;

      async function expectOneRow(destination: "nwc" | "spark") {
        const rows = await sql<{
          id: number;
          username: string;
          created_at: Date;
          destination: string;
          connection_secret: string | null;
          spark_identity_pubkey: string | null;
        }[]>`select id, username, created_at, destination, connection_secret, spark_identity_pubkey from users`;
        expect(rows.length).toBe(1);
        const [row] = rows;
        expect(row.id).toBe(id);
        expect(row.username).toBe("alice");
        expect(row.created_at).toEqual(initial.created_at);
        expect(row.destination).toBe(destination);
        expect(row.connection_secret === null).toBe(destination === "spark");
        expect(row.spark_identity_pubkey === null).toBe(destination === "nwc");
      }

      let step = 0;
      async function registerAgain() {
        step += 1;
        const at = new Date(NOW.getTime() + step * 1000);
        const intent = await db.createBindingIntent({
          npubHex: NPUB,
          username: "alice",
          sparkPubkey: SPARK_KEY,
          now: at,
        });
        expect(intent.kind).toBe("ok");
        return await db.registerSparkAddress(
          registerInput({ hash: `hash-${step}`, ts: REGISTER_TS + step, now: at }),
        );
      }

      expect((await registerAgain()).kind).toBe("switched");
      await expectOneRow("spark");
      expect((await db.bindNwcDestination(NPUB, "enc-back", NOW)).kind).toBe("bound");
      await expectOneRow("nwc");
      expect((await registerAgain()).kind).toBe("switched");
      await expectOneRow("spark");
    });
  },
});

Deno.test({
  name: "a failed register transaction leaves the NWC row, its intent, and no claim",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      await seedNwc(sql, "alice", NPUB);
      await seedActiveIntent(sql);
      const usersBefore = await userSnapshot(sql);
      await installUserWriteFailure(sql);

      let failed = false;
      try {
        await db.registerSparkAddress(registerInput());
      } catch {
        failed = true;
      }

      expect(failed).toBe(true);
      expect(await claimRows(sql)).toEqual([]);
      expect((await allIntents(sql)).length).toBe(1);
      await clearUserWriteFailure(sql);
      expect(await userSnapshot(sql)).toEqual(usersBefore);
    });
  },
});

Deno.test({
  name: "findUserByUsername and findActiveBindingIntent read the row and the unexpired intent",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const id = await seedSpark(sql, "alice", NPUB, SPARK_KEY);
      expect(await db.findUserByUsername("alice")).toEqual({
        id,
        username: "alice",
        nostrPubkey: NPUB,
        destination: "spark",
        sparkIdentityPubkey: SPARK_KEY,
        encryptedConnectionSecret: null,
      });
      expect(await db.findUserByUsername("nobody")).toBeNull();

      await seedIntent(sql, {
        username: "carol",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: secondsFrom(NOW, 60),
      });
      await seedIntent(sql, {
        username: "dave",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: secondsFrom(NOW, -1),
      });
      await seedIntent(sql, {
        username: "erin",
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
        expiresAt: NOW,
      });
      expect(await db.findActiveBindingIntent("carol", NOW)).toEqual({
        nostrPubkey: NPUB_OTHER,
        sparkPubkey: SPARK_KEY_OTHER,
      });
      expect(await db.findActiveBindingIntent("dave", NOW)).toBeNull();
      // Active means expires_at strictly after the clock, the same rule as everywhere else.
      expect(await db.findActiveBindingIntent("erin", NOW)).toBeNull();
      expect(await db.findActiveBindingIntent("nobody", NOW)).toBeNull();
      // Reads never change anything.
      expect((await allIntents(sql)).length).toBe(3);
    });
  },
});

// ---------------------------------------------------------------------------
// Spark webhook against the real database: write-once settlement (L9.2).
// ---------------------------------------------------------------------------

Deno.test({
  name: "the webhook settles once from the server clock and concurrent deliveries write one settled_at",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const { hmac } = await import("npm:@noble/hashes@1.3.1/hmac");
      const { sha256 } = await import("npm:@noble/hashes@1.3.1/sha256");
      const { bytesToHex, hexToBytes } = await import("npm:@noble/hashes@1.3.1/utils");
      const { createSparkWebhookApp } = await import("../spark/webhook.ts");
      const secret = "integration-webhook-secret";
      const preimage = "ab".repeat(32);
      const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
      const userId = await seedSpark(sql, "alice", NPUB, SPARK_KEY);
      await db.createInvoice(userId, {
        amount: 1000,
        description: "spark",
        invoice: "pr-webhook",
        payment_hash: paymentHash,
      } as never, { by: "spark", receiverPubkey: SPARK_KEY });

      const payload = JSON.stringify({
        type: "SPARK_LIGHTNING_RECEIVE_FINISHED",
        payment_preimage: preimage,
        request_status: "SUCCEEDED",
        status: "TRANSFER_COMPLETED",
        receiver_identity_public_key: SPARK_KEY.toUpperCase(),
        timestamp: "2001-01-01T00:00:00Z",
      });
      const signature = bytesToHex(
        hmac(sha256, new TextEncoder().encode(secret), new TextEncoder().encode(payload)),
      );
      const deliver = async (at: Date) => {
        const app = createSparkWebhookApp(db, secret, () => at);
        const res = await app.request("/", {
          method: "POST",
          headers: { "X-Spark-Signature": signature },
          body: payload,
        });
        return { status: res.status, body: await res.text() };
      };

      const t1 = new Date("2026-03-10T10:00:00.000Z");
      const t2 = new Date("2026-03-10T10:00:01.000Z");
      const [a, b] = await Promise.all([deliver(t1), deliver(t2)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body).toBe(b.body);

      const settled = await db.findInvoice(paymentHash);
      expect(settled.preimage).toBe(preimage);
      expect([t1.getTime(), t2.getTime()]).toContain(settled.settledAt?.getTime());

      // A later delivery changes nothing.
      const third = await deliver(new Date("2026-03-10T11:00:00.000Z"));
      expect(third.status).toBe(200);
      const after = await db.findInvoice(paymentHash);
      expect(after.settledAt?.getTime()).toBe(settled.settledAt?.getTime());
      expect(after.preimage).toBe(preimage);
    });
  },
});

Deno.test({
  name: "an NWC payment_received notification is write-once and cannot touch a Spark invoice",
  ignore: !databaseUrl,
  async fn() {
    await withRepo(async ({ sql, db }) => {
      const { NWCPool } = await import("../nwc/nwcPool.ts");
      const nwcUserId = await seedNwc(sql, "bob", NPUB);
      const sparkUserId = await seedSpark(sql, "alice", NPUB_OTHER, SPARK_KEY);
      await db.createInvoice(nwcUserId, {
        amount: 1000,
        description: "nwc",
        invoice: "pr-nwc-notify",
        payment_hash: "hash-nwc-notify",
      } as never, { by: "nwc" });
      await db.createInvoice(sparkUserId, {
        amount: 2000,
        description: "spark",
        invoice: "pr-spark-notify",
        payment_hash: "hash-spark-notify",
      } as never, { by: "spark", receiverPubkey: SPARK_KEY });

      type Notify = (notification: unknown) => Promise<void>;
      const callbacks = new Map<number, Notify>();
      const pool = new NWCPool(db, async (secret) => secret, (url) => ({
        subscribeNotifications: (callback: Notify) => void callbacks.set(Number(url), callback),
        close: () => undefined,
      } as never));
      pool.subscribeUser(String(nwcUserId), nwcUserId);
      pool.subscribeUser(String(sparkUserId), sparkUserId);

      const notify = (userId: number, hash: string, preimage: string, settledAt: number) =>
        callbacks.get(userId)!({
          notification_type: "payment_received",
          notification: { payment_hash: hash, preimage, settled_at: settledAt, invoice: "pr", amount: 1 },
        });

      await notify(nwcUserId, "hash-nwc-notify", "11".repeat(32), 1_700_000_000);
      await notify(nwcUserId, "hash-nwc-notify", "22".repeat(32), 1_700_000_500);
      expect((await db.findInvoice("hash-nwc-notify")).preimage).toBe("11".repeat(32));

      // The Spark owner's NWC subscription (stale or hostile) reporting a preimage for a Spark invoice.
      await notify(sparkUserId, "hash-spark-notify", "33".repeat(32), 1_700_000_000);
      const sparkInvoice = await db.findInvoice("hash-spark-notify");
      expect(sparkInvoice.preimage).toBeNull();
      expect(sparkInvoice.settledAt).toBeNull();
    });
  },
});
