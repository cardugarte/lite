import { Event } from "@nostr/tools";
import { validateZapRequest } from "@nostr/tools/nip57";
import { Hono } from "hono";
import { nwc } from "npm:@getalby/sdk";
import { logger } from "./logger.ts";
import { BASE_URL } from "./constants.ts";
import { DB } from "./db/db.ts";
import { verifyInvoiceSettlement } from "./lud21-verify.ts";
import { isSparkUser } from "./spark/destination.ts";
import type { SparkMinter } from "./spark/minter.ts";

export function createLnurlApp(db: DB, sparkMinter?: SparkMinter) {
  const hono = new Hono();

  hono.get("/:username/callback", async (c) => {
    try {
      const username = c.req.param("username");
      const amount = c.req.query("amount");
      const comment = c.req.query("comment") || "";
      const payerData = c.req.query("payerdata") ? JSON.parse(c.req.query("payerdata") || "") : null;
      const nostr = c.req.query("nostr") ? decodeURIComponent(c.req.query("nostr") || "") : null;

      logger.debug("LNURLp callback", { username, amount, comment, payer_data: payerData, nostr });

      if (!amount) {
        throw new Error("No amount provided");
      }

      let zapRequest: Event | undefined
      if (nostr) {
        const zapValidationError = validateZapRequest(nostr)
        if (zapValidationError) {
          throw new Error(zapValidationError);
        }
        zapRequest = JSON.parse(nostr)
      }

      const description = zapRequest ? zapRequest.content : comment;

      const user = await db.findUser(username);
      const amountMsats = Math.floor(+amount / 1000) * 1000;
      const metadata = {
        comment: comment || undefined,
        payer_data: payerData || undefined,
        nostr: zapRequest || undefined,
      };

      if (isSparkUser(user)) {
        if (!user.sparkIdentityPubkey) {
          throw new Error("spark user missing identity pubkey");
        }
        if (!sparkMinter) {
          throw new Error("spark minter is not configured");
        }
        const minted = await sparkMinter.createInvoice({
          receiverIdentityPubkey: user.sparkIdentityPubkey,
          amountSats: Math.floor(+amount / 1000),
          memo: description,
        });
        await db.createInvoice(user.id, {
          amount: amountMsats,
          description,
          invoice: minted.invoice,
          payment_hash: minted.paymentHash,
          metadata,
        } as unknown as nwc.Nip47Transaction);
        return c.json({
          verify: `${BASE_URL}/lnurlp/${username}/verify/${minted.paymentHash}`,
          routes: [],
          pr: minted.invoice,
        });
      }

      if (!user.connectionSecret) {
        throw new Error("user missing connection secret");
      }

      const nwcClient = new nwc.NWCClient({
        nostrWalletConnectUrl: user.connectionSecret,
      });

      const transaction = await nwcClient.makeInvoice({
        amount: amountMsats,
        description,
        metadata,
      });

      await db.createInvoice(user.id, transaction);

      return c.json({
        verify: `${BASE_URL}/lnurlp/${username}/verify/${transaction.payment_hash}`,
        routes: [],
        pr: transaction.invoice,
      });
    } catch (error) {
      return c.json({ status: "ERROR", reason: "" + error });
    }
  });

  hono.get("/:username/verify/:payment_hash", async (c) => {
    const username = c.req.param("username");
    const paymentHash = c.req.param("payment_hash");

    logger.debug("LNURLp verify", { username, payment_hash: paymentHash });

    let invoice = null;
    try {
      invoice = await db.findInvoice(paymentHash);
    } catch {
      invoice = null;
    }

    let user = null;
    try {
      user = await db.findUser(username);
    } catch {
      user = null;
    }

    const spark = user ? isSparkUser(user) : false;

    const body = await verifyInvoiceSettlement({
      invoice,
      ownerUserId: user?.id ?? null,
      lookupInvoice: async () => {
        if (!user || spark) return null;
        if (!user.connectionSecret) return null;
        const nwcClient = new nwc.NWCClient({
          nostrWalletConnectUrl: user.connectionSecret,
        });
        return await nwcClient.lookupInvoice({ payment_hash: paymentHash });
      },
      markSettled: async (lookup) => {
        if (!user || spark || !lookup.preimage) return;
        await db.markInvoiceSettled(user.id, {
          payment_hash: paymentHash,
          preimage: lookup.preimage,
          settled_at: lookup.settled_at ?? Math.floor(Date.now() / 1000),
        } as nwc.Nip47Transaction);
      },
    });

    return c.json(body);
  });

  return hono;
}
