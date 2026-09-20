import "../test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "../db/db.ts";
import { NWCPool } from "./nwcPool.ts";

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
        destination: null,
        sparkIdentityPubkey: null,
        username: "nwc",
        nostrPubkey: "bb".repeat(32),
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
