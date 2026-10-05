# Alby Lite

A minimal Lightning address server. Each address pays either a wallet reached
through [NWC](https://nwc.dev) or a Spark wallet that stays on the user's
device.

This process is the LNURL server. It does **not** run Breez's LNURL server. It
serves the small part of the Breez management API the Breez SDK needs (register,
recover, availability) on its own public domain, so the unmodified SDK on the
device can claim `username@<LNURL domain>` by calling Lite directly. For Spark
receives Lite holds only a **minter** wallet seed, used to create invoices that
pay the receiver's identity key, and a webhook that settles them.

## Contents

- [Routes](#routes)
- [How a Spark address gets bound](#how-a-spark-address-gets-bound)
- [Configuration](#configuration)
- [CORS](#cors)
- [Settlement and detection events](#settlement-and-detection-events)
- [Operations](#operations)
- [Development](#development)
- [Deployment](#deployment)

## Routes

### Public LNURL (any origin)

| Route | Purpose |
|-------|---------|
| `GET /.well-known/lnurlp/:username` | LNURL-pay request. The address in the metadata is `username@<LNURL domain>`; the callback uses `BASE_URL`. |
| `GET /lnurlp/:username/callback` | Mints an invoice that expires after `INVOICE_EXPIRY_SECS` (default 300). Spark users get a Spark invoice for their identity key, NWC users an NWC invoice. |
| `GET /lnurlp/:username/verify/:payment_hash` | LUD-21 verification, see [Verify](#verify-lud-21). |
| `GET /.well-known/nostr.json` | NIP-05. |

### Public management API: `/lnurlpay/*`

Called by the Breez SDK on the device. Authorization is the SDK's signature
(proof of the Spark key) plus a [binding intent](#how-a-spark-address-gets-bound)
(proof of the account). There is no secret, no npub header, and no cookie.

| Route | Result |
|-------|--------|
| `POST /lnurlpay/:pubkey` | Register. Needs a valid signature and a matching intent. `200 {lnurl, lightning_address}`. |
| `DELETE /lnurlpay/:pubkey` | Unregister. Always refused for the owning key (`409`); `404` for any other key. The username belongs to the account, so switch destination instead. |
| `POST /lnurlpay/:pubkey/recover` | The address bound to the key, or `404`. |
| `POST /lnurlpay/:pubkey/available` | `{available: bool}` for a username and this key. |
| `GET /lnurlpay/:pubkey/metadata` | Always `{"metadata":[]}`, uncached. Keeps the SDK sync loop quiet. |

Rules that matter to clients:

- Every error body is a **JSON string** (for example `"invalid username"`),
  because the SDK shows it verbatim. It is not the `{"status":"ERROR"}` envelope.
- Lite never answers `401` here (the SDK reads it as "Invalid api key"). The
  status set is `200`, `204` (preflight), `400`, `403`, `404`, `409`, `413`, `500`.
- Bodies are capped at 4 KiB (`413`). Nothing touches the database before the
  signature verifies.
- The signed domain is the host of `BASE_URL`, never the request `Host` header.
- `Authorization` is never read or logged. Transfer and registration quota are
  not implemented (`404`).

### Secret routes: `/users`

User writes are authorized by one credential: the registration secret in the
`X-Travelsats-Registration` header. `Origin`, `Authorization`, and cookies never
authorize anything. Account routes also take the account's Nostr key in
`X-Travelsats-Nostr-Pubkey` (64 hex), read only after the secret passes. Errors
are `{"status":"ERROR","reason":"..."}` with a non-2xx status. These routes
carry no CORS headers.

| Route | Body | Result |
|-------|------|--------|
| `POST /users` | `{connectionSecret, nostrPubkey, username?}` | Creates an NWC account. `200 {lightningAddress}`. `409` for a taken username, an account that already has an address, or a name another account is registering. A body with `sparkIdentityPubkey` is a `400`: Spark addresses are bound only through the signed register. |
| `POST /users/binding-intents` | `{username, sparkPubkey}` | Creates the intent for the asserted account. `200 {expiresAt}`. `409` reasons: `name already taken`, `account holds a different username`, `pubkey already holds an address`, `name is being registered`. |
| `POST /users/nwc-bind` | `{connectionSecret}` | Moves the asserted account to NWC in place. `200 {lightningAddress}`; `404 user not found`; `409 name is being registered`. |
| `DELETE /users` | none | Removes the asserted account, its invoices, and its intents. `200 {removed: 0 or 1}`. |

Statuses before the route logic: `503` when the server secret is not set, `403`
when the header is missing or wrong, `400 missing or invalid npub assertion`
for the account routes.

### Spark receive webhook

`POST /spark/webhook`: HMAC-SHA256 of the raw body in `X-Spark-Signature` (hex),
keyed with `SPARK_WEBHOOK_SECRET`. See [Settlement](#settlement-and-detection-events).

### Verify (LUD-21)

`GET /lnurlp/:username/verify/:payment_hash` follows the **invoice**, not the
credential currently on the user row:

| Invoice | Check |
|---------|-------|
| Already settled | Cached preimage, no lookup. |
| Minted by Spark | Stored preimage only. A Spark invoice is settled by the webhook alone, whatever the owner's destination is now. |
| Minted by NWC, owner still on NWC | One NWC `lookupInvoice` with the current secret; a preimage is cached through the write-once path, but only when its SHA-256 is the payment hash. |
| Minted by NWC, owner now on Spark | Cached data only. |

The same rule guards the NWC `payment_received` notification: a preimage whose
SHA-256 is not the notification's payment hash settles nothing and publishes no
zap. Either way Lite logs `nwc_preimage_mismatch` (warn, with the payment hash,
never the preimage).

A hash that does not exist, or belongs to another username, answers
`{"status":"ERROR","reason":"Not found"}` with HTTP 200, as LUD-21 requires.

```json
{ "status": "OK", "settled": true, "preimage": "...", "pr": "lnbc...", "payment_status": "paid" }
```

`status` stays the LNURL envelope (`OK` or `ERROR`) and `settled` keeps its
LUD-21 meaning. `payment_status` is the additive field with Lite's three
answers for an invoice it minted:

| `payment_status` | Meaning |
|------------------|---------|
| `paid` | `settled` is `true`: a proven preimage is stored. |
| `pending` | Not paid yet, **or Lite could not learn the state**: the wallet is unreachable, the lookup failed, or the wallet answered with a preimage that does not hash to the payment hash. Never "not paid", and never an HTTP error. |
| `expired` | The invoice's own expiry has passed and nothing proves a payment. |

The expiry is read from the stored BOLT11 (its timestamp plus its `x` field, or
the BOLT11 default of 3600 seconds when there is none), so invoices minted
before `INVOICE_EXPIRY_SECS` keep the expiry they were minted with. An invoice
whose BOLT11 cannot be decoded has no known expiry and is never `expired`. A
lookup that fails, or contradicts itself, is `pending` even past the expiry. A
payment that is proven later still answers `paid`.

## How a Spark address gets bound

The SDK calls Lite from the browser without a session, so account ownership is
proven **before** the SDK signs, by a binding intent:

1. The app, with the user's session, calls `POST /users/binding-intents` using
   the registration secret and the session's npub. Lite stores a single-use
   intent `{username, npub, spark pubkey}` for 600 seconds. There is one active
   intent per username and one per npub; another account cannot displace an
   unexpired intent.
2. The device runs the SDK's `registerLightningAddress`. Lite verifies the
   signature and the timestamp (plus or minus 600 seconds), then in **one
   transaction**: locks the matching intent, claims the signed statement
   (single use, kept until the statement expires), applies the row table, and
   consumes the intent. Any non-2xx outcome rolls everything back, so a refused
   request burns neither the statement nor the intent.
3. One row per account holds exactly one credential, enforced by the database
   (`destination` is `nwc` or `spark`). Register moves an NWC row to Spark in
   place (same id, username, and address); `POST /users/nwc-bind` moves it back.
   Register by the same key is a no-op; by a new key (after a lost seed) it
   rotates the key on the same row.

`POST /users` and `POST /users/nwc-bind` refuse a name another account holds an
unexpired intent for, so a Spark signup in progress cannot be taken through NWC.

## Configuration

Names only; set secrets in the environment, never in the repository. Copy
`.env.example` to `.env` for local runs.

| Variable | Required | Meaning |
|----------|----------|---------|
| `BASE_URL` | yes | Payer-facing origin. Its host (lowercase, default port dropped) is the **LNURL domain** that is signed and published. Dev: `https://lite-dev.travelsats.ar`. Prod: `https://travelsats.ar`. |
| `DATABASE_URL` | yes | Postgres connection string. Migrations run at startup. |
| `ENCRYPTION_KEY` | yes | Key that encrypts NWC connection secrets in the database (`deno task db:generate:key`). |
| `TRAVELSATS_REGISTRATION_SECRET` | yes | Authorizes `/users` writes. Same value as the app's. Unset or blank answers `503`. Generate with `openssl rand -hex 32`. |
| `APP_ORIGINS` | dev only | Comma-separated browser origins allowed on `/lnurlpay/*`. Dev: `https://dev.travelsats.ar`. Unset (prod): the `BASE_URL` origin. |
| `SPARK_WEBHOOK_URL` | prod | Absolute URL registered with the minter webhook. Default `${BASE_URL}/spark/webhook`. Set it explicitly in prod, where `BASE_URL` is the app and not Lite's own origin (Fly origin plus `/spark/webhook`). Compared as an exact string. |
| `SPARK_WEBHOOK_SECRET` | with minter | HMAC secret registered with the minter webhook. |
| `SPARK_MINTER_MNEMONIC` | with minter | Seed of the **minter** wallet only. Distinct per environment. Not a user seed. |
| `BREEZ_API_KEY` | with minter | Server-side Breez API key for the minter. Never ship it in a client bundle. |
| `SPARK_MINTER_DATABASE_URL` | no | Connection string for the minter's own storage. Default: `DATABASE_URL` with the search path pinned to the `breez_minter` schema. See [Minter storage](#minter-storage). |
| `INVOICE_EXPIRY_SECS` | no | Seconds an invoice Lite mints stays payable, for Spark (`expirySecs`) and NWC (`make_invoice` `expiry`). Default 300, the limit the app's payment countdown shows. A whole number from 1 to 4294967295; anything else stops Lite at startup. Without an explicit expiry the Spark SDK mints 30-day invoices. |
| `NOSTR_NIP57_PRIVATE_KEY` | no | Zapper key, see [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md). |
| `LOG_LEVEL` | no | Log detail. |
| `PORT` | no | Listen port. Default 8080. |
| `LITE_TEST_DATABASE_URL` | tests | Disposable Postgres for `deno task test:integration`. Never a real database. |

The minter needs `BREEZ_API_KEY`, `SPARK_MINTER_MNEMONIC`, and
`SPARK_WEBHOOK_SECRET` together; without all three Lite runs with NWC only.

## CORS

CORS is mounted per route prefix, not globally:

| Prefix | CORS |
|--------|------|
| `/.well-known/lnurlp/*`, `/lnurlp/*`, `/.well-known/nostr.json` | Any origin (payers' wallets). |
| `/lnurlpay/*` | Only `APP_ORIGINS`, no credentials, preflight cached 600 seconds. Mounted **before** the 4 KiB body cap, so a preflight is answered first and a `413` still carries the allow-origin header. Writes allow `Content-Type, Authorization, User-Agent`; the metadata route also allows `X-Breez-Signature` and `X-Breez-Timestamp` (their values are never read). |
| `/users/*`, `/spark/webhook` | None. |

`/ping` and `/robots.txt` carry no CORS headers.

## Settlement and detection events

A preimage alone is not proof of payment. The webhook settles an invoice only
when the transfer completed (`request_status` is `SUCCEEDED` and `status` is
`TRANSFER_COMPLETED`), the invoice was minted by Spark, the SHA-256 of the
preimage matches its payment hash, and the receiver key, when present, equals
the key the invoice was minted for (case-insensitive). The write is conditional
on a missing preimage (write-once) and `settled_at` is the server clock; the
payload timestamp is ignored.

| Outcome | Status |
|---------|--------|
| Bad or missing HMAC | `401` |
| Body is not JSON | `400` |
| Another event type | `200` |
| Preimage missing or not 64 hex | `400` |
| A status field absent or `null` | `503` (the SSP retries; the payload shape is unexpected) |
| Present non-success status | `200`, no write |
| No invoice for the hash | `503` (the invoice row may commit later) |
| NWC-minted invoice, or receiver key mismatch | `200`, no write |
| Valid | `200`, settled once; a repeat is `200` and changes nothing |
| Database error | `500` |

Settlement is **webhook-only**: with the current SDK the minter cannot look up a
payment another identity received, and Lite runs no reconciliation job. A lost
webhook leaves LUD-21 at `settled: false` while the device holds the sats. This
is an accepted gap, detected by six structured log events (the `event` field):

| Event | Level | When |
|-------|-------|------|
| `spark_webhook_unknown_invoice` | error | The hash matches no invoice (`503`). |
| `spark_webhook_status_absent` | error | A status field is absent (`503`). The first one per process also carries the redacted payload. |
| `spark_webhook_receiver_mismatch` | warn | NWC-minted invoice or receiver key mismatch. |
| `spark_webhook_non_success` | warn | Present terminal non-success status. |
| `spark_webhook_receiver_key_absent` | warn | The payload has no receiver key; once per process, with the redacted payload. |
| `spark_settlement_missing` | warn | Verify saw a Spark invoice still unsettled more than 5 minutes after creation. Once per payment hash per process, at most 1,000 hashes tracked. |

No log entry holds a preimage, the HMAC secret, or a signature header value.

The minter also logs `spark_webhook_registered`, `spark_webhook_already_registered`,
`spark_webhook_stale`, and `spark_minter_balance` at connect. The balance must
stay constant across restarts: if it rises while the device's balance does not,
funds are being credited to the minter, so stop and investigate.

## Minter storage

The minter keeps its Breez SDK state (wallet sync data, payments) in Postgres,
in the `breez_minter` schema of the same database. The SDK creates its own
tables there on first connect; migration `0005` only creates the empty schema.
Nothing lives on the container filesystem, so a redeploy never loses it.

Lite derives the minter's connection string from `DATABASE_URL`: other
parameters (such as `sslmode`) are kept, and `options=-c search_path=breez_minter`
is added (merged into an existing `options` value). Set
`SPARK_MINTER_DATABASE_URL` only to point the minter somewhere else; it is then
used exactly as given.

The minter connects in the background at startup. A failed connect is logged
as `spark minter warmup failed` (error name and a message with no secrets) and
the server keeps serving; minting retries the connect on first use.

**Do not expose `breez_minter` through PostgREST.** On Supabase only the schemas
listed in the API settings are exposed, and that list must not include
`breez_minter` (or `public` tables of Lite). The schema holds a wallet's sync
state and must stay server-side.

## Operations

### Webhook registration

On connect the minter lists its webhooks: it registers one only when none has
exactly the configured URL, removes same-URL duplicates beyond the first, and
logs `spark_webhook_stale` with the ids of webhooks that point elsewhere. Stale
ones are **not** deleted, because two environments might share a seed by
mistake. Remove them by hand with the SDK's `unregisterWebhook`, using the minter
seed and the ids from the log. Lite has no command for this.

### Rotating `SPARK_WEBHOOK_SECRET`

The secret is stored with the registered webhook, so changing the variable alone
makes every delivery fail HMAC. Unregister the old webhook id (from the
`spark_webhook_already_registered` log) with the SDK, set the new secret, then
restart Lite so it registers a fresh webhook.

### Rotating `TRAVELSATS_REGISTRATION_SECRET`

Change it on Lite and on the app together; until both match, `/users` writes
answer `403`.

### Manual database rollback

The migration is not reversible by the migrator. To go back to the previous
image, run `drizzle/rollback/0004_down.sql` first (it is not in the migration
journal), then redeploy. It drops the four constraints and both partial unique
indexes, makes `destination` and `minted_by` nullable again, and recreates the
empty legacy table. The new tables and columns stay; the old code ignores them.
Never drop `users` or `invoices`.

### Deployment checks

After deploying, confirm in the logs that the migration applied, the webhook is
registered (or already registered), and `spark_minter_balance` is logged. Then
probe, replacing `<PUBKEY>` with any 66-hex compressed key:

```sh
# Forged Origin does not authorize anything: 403
curl -X POST "$BASE_URL/users" -H 'Origin: https://travelsats.ar' -d '{}'

# Preflight from an app origin: allow-origin and Authorization/User-Agent, no X-Breez headers
curl -i -X OPTIONS "$BASE_URL/lnurlpay/<PUBKEY>" \
  -H 'Origin: https://dev.travelsats.ar' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization,user-agent'

# Oversized body from an app origin: 413 that still carries allow-origin
curl -i -X POST "$BASE_URL/lnurlpay/<PUBKEY>/recover" \
  -H 'Origin: https://dev.travelsats.ar' -H 'content-type: application/json' \
  --data-binary "$(head -c 5120 /dev/zero | tr '\0' x)"
```

A signed webhook delivery can be reproduced against a seeded invoice with an
HMAC of the exact body:

```sh
BODY='{"type":"SPARK_LIGHTNING_RECEIVE_FINISHED","payment_preimage":"<64 hex>","request_status":"SUCCEEDED","status":"TRANSFER_COMPLETED"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SPARK_WEBHOOK_SECRET" -hex | cut -d' ' -f2)
curl -X POST "$BASE_URL/spark/webhook" -H "X-Spark-Signature: $SIG" -d "$BODY"
```

## Development

- [Install Deno](https://docs.deno.com/runtime/manual/getting_started/installation/)
- Copy `.env.example` to `.env`
- Run in dev mode: `deno task dev`

### Creating a new migration

- Edit the schema (`./src/db/schema.ts`)
- Create the migration files: `deno task db:generate`
- The migration will automatically happen when the app starts.

Drizzle has no builder for check constraints or partial indexes, so those live
in the migration SQL only. After hand-editing a migration, run
`deno task db:generate` again: it must report no schema changes.

### Running Tests

- Unit tests need no database and no network: `deno task test`
- Integration tests run the migrations and the repository against a real
  Postgres. Point `LITE_TEST_DATABASE_URL` at a **disposable** server (each test
  creates and drops its own database):
  `LITE_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres deno task test:integration`.
  The suite skips itself, and says so, when the variable is unset.
- Type check: `deno check src/main.ts src/app.ts`

## Deployment

### Run with Deno

`deno task start`

### Docker (from Alby's Container Registry)

`docker run -p 8080:8080 --pull always ghcr.io/getalby/lite:latest`

### Docker (from source)

`docker run -p 8080:8080 $(docker build -q .)`

### Deploy on Fly

Make sure to update the `app` name and `BASE_URL` in fly.toml, then run:

- `fly launch`

_When launching, make sure to include a postgres database when setting up the app, then update your app environment variables with `fly secrets set`._
