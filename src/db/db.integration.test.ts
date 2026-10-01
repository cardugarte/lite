import { expect } from "jsr:@std/expect";
import postgres from "npm:postgres@3.4.5";

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
      await applyNamed(sql, THROUGH_0003);
      Deno.env.set("DATABASE_URL", url);
      Deno.env.set("BASE_URL", "http://lnaddr.test");
      Deno.env.set("ENCRYPTION_KEY", ZERO_KEY);
      const { DB } = await import("./db.ts");
      const db = new DB();
      const created = await db.createUser(NWC_URL, "Alice", "AB".repeat(32));
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

      await applyNamed(sql, [MIGRATION_0004]);
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
