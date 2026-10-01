import type { RegisterResult, StatementClaim, UserRow } from "../db/db.ts";
import { claimExpiresAt, statementHash } from "./verify.ts";

/** What the management service needs from the database. `DB` satisfies it structurally. */
export interface LnurlpayRepository {
  registerSparkAddress(input: {
    username: string;
    sparkPubkey: string;
    statement: StatementClaim;
    now: Date;
  }): Promise<RegisterResult>;
  findUserBySparkPubkey(pubkey: string): Promise<UserRow | null>;
  findUserByUsername(username: string): Promise<UserRow | null>;
  findActiveBindingIntent(
    username: string,
    now: Date,
  ): Promise<{ nostrPubkey: string; sparkPubkey: string } | null>;
}

export interface LnurlpayDeps {
  repo: LnurlpayRepository;
  nwcPool: { unsubscribeUser(userId: number): void };
  /** The LNURL domain every address and signed message uses. */
  domain: string;
  /** Lite's clock. */
  now: () => Date;
}

/** An HTTP answer. Error bodies are JSON strings because the SDK shows them verbatim. */
export interface Reply {
  status: 200 | 403 | 404 | 409;
  body: string | Record<string, string | boolean>;
}

const NOT_FOUND: Reply = { status: 404, body: "user not found" };

const REGISTER_CONFLICT_TEXT = {
  statement_used: "signature has already been used",
  name_taken: "name already taken",
  account_username_differs: "account holds a different username",
  pubkey_taken: "pubkey already holds an address",
} as const;

/**
 * Register, unregister, recover, and available over a repository port. Inputs
 * are already verified: the route checked the fields, the freshness, and the
 * signature before calling any of these.
 */
export function createLnurlpayService(deps: LnurlpayDeps) {
  const { repo, nwcPool, domain, now } = deps;

  const addressBody = (username: string) => ({
    lnurl: `https://${domain}/.well-known/lnurlp/${username}`,
    lightning_address: `${username}@${domain}`,
  });

  return {
    async register(input: {
      username: string;
      pubkey: string;
      timestamp: number;
      message: string;
    }): Promise<Reply> {
      const result = await repo.registerSparkAddress({
        username: input.username,
        sparkPubkey: input.pubkey,
        statement: {
          hash: statementHash(input.pubkey, input.message),
          route: "register",
          expiresAt: claimExpiresAt(input.timestamp),
        },
        now: now(),
      });
      if (result.kind === "no_intent") {
        return { status: 403, body: "no binding intent for this username and pubkey" };
      }
      if (result.kind === "conflict") {
        return { status: 409, body: REGISTER_CONFLICT_TEXT[result.reason] };
      }
      if (result.kind === "switched") nwcPool.unsubscribeUser(result.user.id);
      return { status: 200, body: addressBody(input.username) };
    },

    /** Never deletes or answers 2xx: the username belongs to the account. */
    async unregister(input: { pubkey: string }): Promise<Reply> {
      const row = await repo.findUserBySparkPubkey(input.pubkey);
      if (row) {
        return { status: 409, body: "address cannot be released; switch destination instead" };
      }
      return NOT_FOUND;
    },

    async recover(input: { pubkey: string }): Promise<Reply> {
      const row = await repo.findUserBySparkPubkey(input.pubkey);
      if (!row) return NOT_FOUND;
      return {
        status: 200,
        body: { ...addressBody(row.username), username: row.username, description: `Sats for ${row.username}` },
      };
    },

    /**
     * True only when no row holds the name (or the Spark row holding it is
     * bound to this key) and no active intent names another key.
     */
    async available(input: { pubkey: string; username: string }): Promise<Reply> {
      const row = await repo.findUserByUsername(input.username);
      const nameFree = !row || (row.destination === "spark" && row.sparkIdentityPubkey === input.pubkey);
      const intent = await repo.findActiveBindingIntent(input.username, now());
      const intentFree = !intent || intent.sparkPubkey === input.pubkey;
      return { status: 200, body: { available: nameFree && intentFree } };
    },
  };
}
