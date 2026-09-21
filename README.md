# Alby Lite

A minimal Lightning address server powered by [NWC](https://nwc.dev)
and Spark invoice minting for `@travelsats.ar` addresses.

This process is the LNURL server. It does **not** run Breez's LNURL server
(that would collide with `/.well-known/lnurlp/` and attribute receives to a
partner API key). Spark users keep their own seed; this server holds only a
**minter** wallet seed used to create invoices for the receiver's identity
public key and to receive the invoice-creator webhook.

## API

### Create a new user

`POST /users`

NWC (unchanged):

```json
{
  "connectionSecret": "nostr+walletconnect://...",
  "nostrPubkey": "npubg3tal6y...",
  "username": "" // optional
}
```

Spark (no spending secret):

```json
{
  "sparkIdentityPubkey": "02…33-byte compressed identity pubkey hex…",
  "nostrPubkey": "npubg3tal6y...",
  "username": "" // optional
}
```

Provide exactly one of `connectionSecret` or `sparkIdentityPubkey`. Duplicate
usernames still return `{ "status": "ERROR", "reason": "Username has already been taken" }`.

`returns`

```
{
    "lightningAddress": "91290133601@albylite.com"
}
```

### Rebind destination

`POST /users/rebind`

Requires the user's existing Nostr pubkey **and** a single-use rebind token
issued to that username (`DB.issueRebindToken(username)` — operator issuance
HTTP is a follow-up). Replay of a used token is rejected.

```json
{
  "username": "alice",
  "nostrPubkey": "hex or npub",
  "rebindToken": "…",
  "sparkIdentityPubkey": "02…"
}
```

Or `connectionSecret` instead of `sparkIdentityPubkey` to bind NWC.

### Spark receive webhook

`POST /spark/webhook`

HMAC-SHA256 of the raw body in `X-Spark-Signature` (hex), using
`SPARK_WEBHOOK_SECRET`. On `SPARK_LIGHTNING_RECEIVE_FINISHED`, persists
`payment_preimage` keyed by `sha256(preimage)`. LUD-21 for spark rows
answers from that preimage and does not call NWC.

### Verify an invoice (LUD-21)

`GET /lnurlp/:username/verify/:payment_hash`

If the row is already settled, returns the cached preimage. NWC users: if unpaid,
asks the **owner** wallet with NWC `lookupInvoice` and persists a preimage when
Hub has one. Spark users: never call NWC; unpaid stays `settled: false` until
the minter webhook persists the preimage. Lookup failure returns `settled: false`
(does not 500). Username must own the invoice. This route is public and has no
rate limit. TravelSats uses it as the QR/external fallback; connected /
Hub-isolated pay hashes the WebLN preimage first.

```json
{ "status": "OK", "settled": true, "preimage": "...", "pr": "lnbc..." }
```

## Development

- [Install Deno](https://docs.deno.com/runtime/manual/getting_started/installation/)
- Copy `.env.example` to `.env`
- Run in dev mode: `deno task dev`

### Creating a new migration

- Edit the schema (`./src/db/schema.ts`)
- Create the migration files: `deno task db:generate`
- The migration will automatically happen when the app starts.

### Running Tests

`deno task test`

## Deployment

### Configuration Parameters

- LOG_LEVEL: Sets the amount of detail in logs
- BASE_URL: Base url of the lightning address server
- DATABASE_URL: Postgres connection string
- ENCRYPTION_KEY: Secret used to encrypt NWC connection secrets in the DB
- NOSTR_NIP57_PRIVATE_KEY: private key of zapper service, see [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) for more info
- BREEZ_API_KEY: server-side Breez API key for the Spark minter (never ship in a client bundle)
- SPARK_MINTER_MNEMONIC: seed of the **minter** wallet only (create invoices + creator webhook). Not a user seed. Do not enable SDK multi-user server mode.
- SPARK_WEBHOOK_SECRET: HMAC secret registered with the minter webhook
- SPARK_WEBHOOK_URL: optional absolute URL Breez POSTs (default `${BASE_URL}/spark/webhook`). Until `travelsats.ar` proxies `/spark/webhook`, set this to the Fly origin.
- SPARK_MINTER_STORAGE_DIR: optional SDK storage dir (default `./.spark-minter`)

Spark minting uses the same Postgres as NWC users. There is no second database
and no Breez LNURL server.

_Environment variables must be setup, including a postgres database connection. Please see .env.example._

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
