import "./test_setup.ts";
import { expect } from "jsr:@std/expect";
import type { DB } from "./db/db.ts";
import { LNURL_DOMAIN } from "./constants.ts";
import { createLnurlApp } from "./lnurlp.ts";
import { createLnurlpayService } from "./lnurlpay/service.ts";
import type { SparkMinter } from "./spark/minter.ts";
import { createUsersApp } from "./users.ts";
import { NWCPool } from "./nwc/nwcPool.ts";
import { createNostrWellKnownApp } from "./well-known/nostr.ts";
import { createLnurlWellKnownApp } from "./well-known/lnurlp.ts";

/**
 * `hello` and `zuricata` are already registered. The reserved-name block
 * applies to new registrations only, so lookup, NIP-05, LNURL pay, recover,
 * and delete keep resolving those rows.
 */

const NOSTR = "aa".repeat(32);
const SPARK = "02" + "ab".repeat(32);
const NAMES = ["hello", "zuricata"] as const;

function row(username: string) {
  return {
    id: username === "hello" ? 1 : 2,
    username,
    nostrPubkey: NOSTR,
    destination: "spark" as const,
    sparkIdentityPubkey: SPARK,
    connectionSecret: null,
    encryptedConnectionSecret: null,
  };
}

Deno.test("an existing reserved-name user still resolves for NIP-05, LNURL pay, recover, and delete", async () => {
  const db = {
    findUser: async (username: string) => {
      const found = NAMES.find((name) => name === username);
      if (!found) throw new Error("user not found");
      return row(found);
    },
    createInvoice: async () => {},
    findUserByNostrPubkey: async () => ({ id: 1 }),
    deleteUserByNostrPubkey: async () => 1,
    findUserBySparkPubkey: async () => row("zuricata"),
  } as unknown as DB;

  const nip05 = createNostrWellKnownApp(db);
  const lnurl = createLnurlWellKnownApp(db);
  const pay = createLnurlApp(db, {
    async createInvoice() {
      return { invoice: "lnbc1existing", paymentHash: "ee".repeat(32), receiverPubkey: SPARK };
    },
  } as SparkMinter);

  for (const username of NAMES) {
    const nostr = await nip05.request(`/?name=${username}`);
    expect(nostr.status).toEqual(200);
    expect(await nostr.json()).toEqual({ names: { [username]: NOSTR } });

    const discovery = await lnurl.request(`/${username}`);
    expect(discovery.status).toEqual(200);
    const body = await discovery.json();
    expect(body.tag).toEqual("payRequest");
    expect(body.callback).toEqual(`http://lnaddr.test/lnurlp/${username}/callback`);
    expect(JSON.parse(body.metadata)[0]).toEqual(["text/identifier", `${username}@${LNURL_DOMAIN}`]);

    const callback = await pay.request(`/${username}/callback?amount=1000`);
    expect(callback.status).toEqual(200);
    expect(await callback.json()).toEqual({
      verify: `http://lnaddr.test/lnurlp/${username}/verify/${"ee".repeat(32)}`,
      routes: [],
      pr: "lnbc1existing",
    });
  }

  const recovered = await createLnurlpayService({
    repo: db as never,
    nwcPool: { unsubscribeUser() {} },
    domain: LNURL_DOMAIN,
    now: () => new Date("2026-03-01T12:00:00.000Z"),
  }).recover({ pubkey: SPARK });
  expect(recovered).toEqual({
    status: 200,
    body: {
      lnurl: `https://${LNURL_DOMAIN}/.well-known/lnurlp/zuricata`,
      lightning_address: `zuricata@${LNURL_DOMAIN}`,
      username: "zuricata",
      description: "Sats for zuricata",
    },
  });

  const previous = Deno.env.get("TRAVELSATS_REGISTRATION_SECRET");
  Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", "s3cret");
  try {
    const app = createUsersApp(db, { subscribeUser() {}, unsubscribeUser() {} } as unknown as NWCPool);
    const deleted = await app.request("/", {
      method: "DELETE",
      headers: {
        "X-Travelsats-Registration": "s3cret",
        "X-Travelsats-Nostr-Pubkey": NOSTR,
      },
    });
    expect(deleted.status).toEqual(200);
    expect(await deleted.json()).toEqual({ removed: 1 });
  } finally {
    if (previous == null) Deno.env.delete("TRAVELSATS_REGISTRATION_SECRET");
    else Deno.env.set("TRAVELSATS_REGISTRATION_SECRET", previous);
  }
});
