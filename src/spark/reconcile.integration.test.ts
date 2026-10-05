import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import postgres from "npm:postgres@3.4.5";
import { DB } from "../db/db.ts";
import { createLnurlApp } from "../lnurlp.ts";
import { makeInvoice } from "../test_bolt11.ts";
import { createSparkReconciler } from "./reconcile.ts";
import type { SspClient, SspLightningReceive } from "./ssp.ts";

// A lost webhook, recovered through the real repository: the verify route, the
// reconciler, `findInvoiceByPaymentHash` and the write-once `settleSparkInvoice`
// against a real Postgres, with a fake SSP in place of the network.

const databaseUrl = Deno.env.get("LITE_TEST_DATABASE_URL")?.trim() || "";
if (!databaseUrl) {
  console.log("ignore: LITE_TEST_DATABASE_URL is unset; integration tests need a disposable Postgres");
}

const migrationDir = new URL("../../drizzle/", import.meta.url);
const MIGRATIONS = [
  "0000_greedy_phalanx.sql",
  "0001_white_prism.sql",
  "0002_green_frightful_four.sql",
  "0003_spark_destination.sql",
  "0004_breez_native_address.sql",
];

const RECEIVER = "02" + "cd".repeat(32);
const NPUB = "11".repeat(32);
const PREIMAGE = "ab".repeat(32);
const HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));

type Sql = ReturnType<typeof postgres>;

function databaseNamed(name: string): string {
  return databaseUrl.replace(/\/[^/?]*(\?.*)?$/, `/${name}$1`);
}

async function withDatabase(fn: (sql: Sql, url: string) => Promise<void>): Promise<void> {
  const name = `lite_it_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseNamed("postgres"), { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const url = databaseNamed(name);
  const sql = postgres(url, { max: 1 });
  try {
    for (const file of MIGRATIONS) {
      const text = await Deno.readTextFile(new URL(file, migrationDir));
      const statements = text.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0);
      await sql.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement);
      });
    }
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

const record = (over: Partial<SspLightningReceive> = {}, createdMs = Date.now() - 60_000): SspLightningReceive => ({
  id: "SparkLightningReceiveRequest:integration",
  created_at: new Date(createdMs).toISOString(),
  updated_at: new Date(createdMs).toISOString(),
  request_status: "CREATED",
  status: "INVOICE_CREATED",
  payment_preimage: null,
  receiver_identity_public_key: null,
  invoice: {
    payment_hash: HASH,
    created_at: new Date(createdMs).toISOString(),
    expires_at: new Date(createdMs + 300_000).toISOString(),
  },
  ...over,
});

const paid = (over: Partial<SspLightningReceive> = {}) =>
  record({
    request_status: "SUCCEEDED",
    status: "TRANSFER_COMPLETED",
    payment_preimage: PREIMAGE,
    receiver_identity_public_key: RECEIVER,
    ...over,
  });

async function seed(sql: Sql, db: DB) {
  const [{ id }] = await sql<{ id: number }[]>`
    insert into users (connection_secret, username, nostr_pubkey, destination, spark_identity_pubkey)
    values (null, 'alice', ${NPUB}, 'spark', ${RECEIVER})
    returning id
  `;
  await db.createInvoice(Number(id), {
    amount: 21_000,
    description: "booking",
    invoice: makeInvoice({ paymentHash: HASH, timestamp: Math.floor(Date.now() / 1000) - 60, expirySecs: 300 }),
    payment_hash: HASH,
  } as never, { by: "spark", receiverPubkey: RECEIVER });
}

const stored = async (sql: Sql) =>
  (await sql<{ preimage: string | null; settled_at: Date | null }[]>`
    select preimage, settled_at from invoices where payment_hash = ${HASH}
  `)[0];

Deno.test({
  name: "a lost webhook is recovered at verify time through the real repository, once",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDatabase(async (sql, url) => {
      const db = new DB(url);
      try {
        await seed(sql, db);
        let listed: SspLightningReceive[] = [record()];
        let sspCalls = 0;
        const ssp: SspClient = {
          listLightningReceives: async () => {
            sspCalls += 1;
            return { entries: listed, hasNextPage: false, endCursor: null };
          },
        };
        // No throttle: this test asks again straight away.
        const reconciler = createSparkReconciler({ ssp, db, throttleMs: 0 });
        const app = createLnurlApp(db, undefined, undefined, { sparkReconciler: reconciler });
        const verify = async () => (await app.request(`/alice/verify/${HASH}`)).json();

        // The SSP knows the invoice and it is not paid: pending, nothing written.
        expect(await verify()).toMatchObject({ status: "OK", settled: false, preimage: null, payment_status: "pending" });
        expect(await stored(sql)).toEqual({ preimage: null, settled_at: null });

        // A record for the right invoice that carries another receiver's key settles nothing.
        listed = [paid({ receiver_identity_public_key: "03" + "ee".repeat(32) })];
        expect(await verify()).toMatchObject({ settled: false, payment_status: "pending" });
        expect(await stored(sql)).toEqual({ preimage: null, settled_at: null });

        // The webhook never arrived, but the SSP lists the payment: settled, write-once.
        listed = [paid()];
        const before = Date.now();
        expect(await verify()).toMatchObject({ status: "OK", settled: true, preimage: PREIMAGE, payment_status: "paid" });
        const row = await stored(sql);
        expect(row.preimage).toEqual(PREIMAGE);
        expect(row.settled_at!.getTime()).toBeGreaterThanOrEqual(before - 1_000);

        // Settled: the cache answers and the SSP is not asked again.
        const asked = sspCalls;
        expect(await verify()).toMatchObject({ settled: true, preimage: PREIMAGE, payment_status: "paid" });
        expect(sspCalls).toEqual(asked);

        // A late webhook for the same payment changes nothing.
        expect(await db.settleSparkInvoice(HASH, "cd".repeat(32))).toEqual("already_settled");
        expect((await stored(sql)).preimage).toEqual(PREIMAGE);
      } finally {
        await db.close();
      }
    });
  },
});

Deno.test({
  name: "a webhook that settled first makes the reconciler report paid without writing again",
  ignore: !databaseUrl,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withDatabase(async (sql, url) => {
      const db = new DB(url);
      try {
        await seed(sql, db);
        expect(await db.settleSparkInvoice(HASH, PREIMAGE, new Date("2026-10-04T16:00:00Z"))).toEqual("settled");
        const before = await stored(sql);
        const ssp: SspClient = {
          listLightningReceives: async () => ({ entries: [paid()], hasNextPage: false, endCursor: null }),
        };
        const outcome = await createSparkReconciler({ ssp, db })({
          paymentHash: HASH,
          paymentRequest: "lnbc1sparkinvoice",
          createdAt: new Date(),
        });
        expect(outcome).toEqual({ kind: "paid", preimage: PREIMAGE });
        expect(await stored(sql)).toEqual(before);
      } finally {
        await db.close();
      }
    });
  },
});
