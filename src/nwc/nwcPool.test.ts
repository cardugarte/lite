import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import { sha256 } from "npm:@noble/hashes@1.3.1/sha256";
import { bytesToHex, hexToBytes } from "npm:@noble/hashes@1.3.1/utils";
import type { DB } from "../db/db.ts";
import { captureLogs, entriesFor } from "../test_logs.ts";
import { NWCPool } from "./nwcPool.ts";

/** The payment hash a preimage proves, computed here and not by the code under test. */
const hashOf = (preimage: string) => bytesToHex(sha256(hexToBytes(preimage)));
const PREIMAGE_A = "11".repeat(32);
const PREIMAGE_B = "22".repeat(32);

Deno.test("nwcPool.init skips spark rows and never decrypts them", async () => {
  const decryptCalls: Array<string | null> = [];
  const subscribed: number[] = [];
  const db = {
    getAllUsers: async () => [
      {
        id: 1,
        encryptedConnectionSecret: null,
        destination: "spark",
        sparkIdentityPubkey: "02ab",
        username: "spark",
        nostrPubkey: "aa".repeat(32),
      },
      {
        id: 2,
        encryptedConnectionSecret: "enc-nwc",
        destination: "nwc",
        sparkIdentityPubkey: null,
        username: "nwc",
        nostrPubkey: "bb".repeat(32),
      },
      {
        id: 3,
        encryptedConnectionSecret: "enc-null-dest",
        destination: null,
        sparkIdentityPubkey: "02ab",
        username: "leftover",
        nostrPubkey: "cc".repeat(32),
      },
    ],
  } as unknown as DB;

  const pool = new NWCPool(db, async (secret) => {
    decryptCalls.push(secret);
    if (!secret) throw new Error("decrypt must not be called on a spark row");
    return "nostr+walletconnect://ok";
  });
  pool.subscribeUser = (_connectionSecret: string, userId: number) => {
    subscribed.push(userId);
  };

  await pool.init();
  expect(decryptCalls).toEqual(["enc-nwc"]);
  expect(subscribed).toEqual([2]);
});

Deno.test("subscribeUser replaces an existing subscription for the same userId", () => {
  const closed: string[] = [];
  let created = 0;
  const pool = new NWCPool(
    { getAllUsers: async () => [] } as unknown as DB,
    async (secret) => secret,
    (url: string) => {
      created += 1;
      const label = url;
      return {
        subscribeNotifications: () => undefined,
        close: () => closed.push(label),
      };
    },
  );
  pool.subscribeUser("first", 1);
  pool.subscribeUser("second", 1);
  expect(created).toEqual(2);
  expect(closed).toEqual(["first"]);
  pool.unsubscribeUser(1);
  expect(closed).toEqual(["first", "second"]);
});

type Delivered = (notification: unknown) => Promise<void>;

/** A pool wired to a fake repository; `deliver` plays a notification into it. */
function poolWithRepository(markInvoiceSettled: (userId: number, transaction: { payment_hash: string; preimage: string }) => Promise<void>) {
  // Any other repository method would be undefined here and fail the test.
  const db = { getAllUsers: async () => [], markInvoiceSettled } as unknown as DB;
  let deliver: Delivered | undefined;
  const pool = new NWCPool(
    db,
    async (secret) => secret,
    () => ({
      subscribeNotifications: (callback: (notification: never) => Promise<void>) => {
        deliver = callback as Delivered;
      },
      close: () => undefined,
    }),
  );
  const zaps: Array<{ userId: number; paymentHash: string }> = [];
  pool.publishZap = async (userId, transaction) => {
    zaps.push({ userId, paymentHash: transaction.payment_hash });
  };
  pool.subscribeUser("secret", 5);
  return { pool, deliver: (notification: unknown) => deliver!(notification), zaps };
}

const received = (preimage: string, paymentHash: string = hashOf(preimage)) => ({
  notification_type: "payment_received",
  notification: { payment_hash: paymentHash, preimage, settled_at: 1_700_000_000 },
});

Deno.test("a payment_received notification settles only through the user-scoped write-once repository call", async () => {
  const calls: Array<{ userId: number; paymentHash: string; preimage: string }> = [];
  const { deliver } = poolWithRepository(async (userId, transaction) => {
    calls.push({ userId, paymentHash: transaction.payment_hash, preimage: transaction.preimage });
  });
  await deliver(received(PREIMAGE_A));
  // A repeat delivery still reaches the repository: write-once is its job.
  await deliver(received(PREIMAGE_A));
  await deliver({ notification_type: "payment_sent", notification: { payment_hash: hashOf(PREIMAGE_B) } });
  expect(calls).toEqual([
    { userId: 5, paymentHash: hashOf(PREIMAGE_A), preimage: PREIMAGE_A },
    { userId: 5, paymentHash: hashOf(PREIMAGE_A), preimage: PREIMAGE_A },
  ]);
});

Deno.test("a notification whose preimage does not hash to its payment_hash settles nothing and publishes no zap", async () => {
  let writes = 0;
  const { deliver, zaps } = poolWithRepository(async () => {
    writes += 1;
  });
  const { entries, raw } = await captureLogs(async () => {
    await deliver(received(PREIMAGE_B, hashOf(PREIMAGE_A)));
    await deliver(received("not-a-preimage", hashOf(PREIMAGE_A)));
  });
  expect(writes).toBe(0);
  expect(zaps).toEqual([]);
  const mismatches = entriesFor(entries, "nwc_preimage_mismatch");
  expect(mismatches.length).toBe(2);
  expect(mismatches[0].level).toBe("WARN");
  expect(mismatches[0].args?.payment_hash).toBe(hashOf(PREIMAGE_A));
  expect(mismatches[0].args?.user_id).toBe(5);
  expect(raw).not.toContain(PREIMAGE_B);
});

Deno.test("a valid notification settles the invoice and then publishes the zap", async () => {
  const order: string[] = [];
  const { deliver, zaps } = poolWithRepository(async () => {
    order.push("settle");
  });
  await deliver(received(PREIMAGE_A));
  expect(order).toEqual(["settle"]);
  expect(zaps).toEqual([{ userId: 5, paymentHash: hashOf(PREIMAGE_A) }]);
});

Deno.test("no notification log line carries the preimage, on success or on a repository failure", async () => {
  for (const failing of [false, true]) {
    const { deliver } = poolWithRepository(async () => {
      if (failing) throw new Error("database unavailable");
    });
    const { raw } = await captureLogs(() => deliver(received(PREIMAGE_A)));
    expect({ failing, leaked: raw.includes(PREIMAGE_A) }).toEqual({ failing, leaked: false });
  }
});
