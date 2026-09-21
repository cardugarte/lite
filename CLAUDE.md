# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Alby Lite is a minimal Lightning address server powered by NWC (Nostr Wallet Connect). It allows users to create Lightning addresses connected to their NWC-enabled wallets and supports NIP-57 zaps.

## Development Commands

```bash
# Run in development mode (with hot reload)
deno task dev

# Run tests
deno task test

# Start production server
deno task start

# Generate database migration after schema changes
deno task db:generate

# Generate encryption key for NWC secrets
deno task db:generate:key

# Cache dependencies
deno task cache
```

## Architecture

### Core Components

- **main.ts**: Entry point - initializes Hono server, runs migrations, sets up NWCPool
- **users.ts**: User registration (`POST /users`) and single-use rebind (`POST /users/rebind`)
- **lnurlp.ts**: LNURL-pay callback and LUD-21 verification endpoints
- **lud21-verify.ts**: GET verify body — cached settle or NWC `lookupInvoice`
- **spark/**: SparkMinter port, Breez WASM adapter, webhook HMAC, destination routing
- **nwc/nwcPool.ts**: Manages NWC client subscriptions for all users, handles payment notifications and zap publishing. Skips spark rows.
- **well-known/**: Serves `.well-known/lnurlp` and `.well-known/nostr.json` endpoints

### Database

Uses Drizzle ORM with PostgreSQL:
- **schema.ts**: Defines `users` and `invoices` tables
- **db.ts**: Database operations (create/find users, manage invoices)
- **aesgcm.ts**: AES-GCM encryption for NWC connection secrets

### Key Flow

1. User registers with NWC connection secret and Nostr pubkey via `POST /users`
2. NWCPool subscribes to payment notifications for the user's wallet
3. LNURL-pay callback creates an invoice via NWC `makeInvoice` and stores the row
4. `payment_received` marks the row settled (awaited) and may publish a zap
5. LUD-21 `GET /lnurlp/:user/verify/:payment_hash`: if the row is unpaid, ask
   the **owner** wallet with NWC `lookupInvoice` (Hub). Persist preimage when
   present. Lookup failure returns `settled: false` (poller-safe). Username
   must own the invoice. This GET has no rate limit. TravelSats connected /
   Hub-isolated pay uses BOLT11 preimage first; this verify path is the
   no-preimage (QR) fallback, not payer-wallet lookup.

## Environment Variables

Required in `.env` (see `.env.example`):
- `DATABASE_URL`: PostgreSQL connection string
- `ENCRYPTION_KEY`: For encrypting NWC secrets (generate with `deno task db:generate:key`)
- `NOSTR_NIP57_PRIVATE_KEY`: Zapper service private key for signing zap receipts
- `BASE_URL`: Public URL of the server
- `LOG_LEVEL`: Logging verbosity

---

## Fork-Specific: Travelsats Deployment

This repository is a fork of [`getAlby/lite`](https://github.com/getAlby/lite)
maintained for the Travelsats platform deployment.

### Differences from upstream

This fork is a minimal extension of upstream. Current deltas:

1. **`fix: copy drizzle migrations folder in Docker image`** (commit `2adf193`)
   — ensures the `drizzle/` directory is present in the runtime image so the
   migrator can find `meta/_journal.json` on startup. Likely candidate for an
   upstream PR.
2. Commit `993e393` adapts the Fly configuration for the Travelsats deployment,
   and **`chore(fly): switch primary region from gru to iad`**
   (commit `aa4c556`) — `fly.toml` parameters tuned for the production
   Travelsats deployment (app name, region, memory, healthcheck grace,
   `min_machines_running=1` to preserve NWC subscriptions).
3. **`docs: add CLAUDE.md and deployment guide`** (commit `0392ced`) — this
   file plus initial deployment notes (the original GCP-era guide is
   superseded by the Travelsats infrastructure doc linked below).

Fork business-logic delta (on top of the deploy/docs commits above):

4. **LUD-21 verify asks the owner wallet** — if `lite.invoices` is unpaid,
   GET verify calls NWC `lookupInvoice` against the **owner** connection
   secret (Hub), persists preimage, returns
   `{ status: OK, settled, preimage, pr }`. This is receiver-side proof for
   TravelSats QR/external pay. Connected/Hub-isolated pay settles with
   BOLT11 preimage in Next and does not need this roundtrip. Missed
   `payment_received` must not keep a paid invoice `settled: false`.
   Tests: `src/lud21-verify.test.ts`. Related: travelsats.ar#1412.
5. **Spark minter (issue #1556 / epic #1550)** — additive `users.destination`
   (NULL = nwc), `users.spark_identity_pubkey`, nullable `connection_secret`.
   `POST /users` with `sparkIdentityPubkey` (xor NWC secret) stores no spendable
   secret. LNURL callback mints via `@breeztech/breez-sdk-spark@0.25.0` Deno
   WASM for the **row** identity pubkey (request destination ignored). Creator
   webhook `POST /spark/webhook` HMAC-verifies `X-Spark-Signature` and persists
   preimage; spark LUD-21 never calls NWC. `nwcPool.init` skips spark rows.
   Rebind is `POST /users/rebind` with nostr pubkey + single-use token. Minter
   seed is not a user seed; no Breez LNURL server; no second Postgres.

### Production environment

- **Platform:** Fly.io
- **App name:** `travelsats-alby-lite`
- **Primary region:** `iad` (Ashburn, Virginia, US East)
- **Public URL via Cloudflare Worker:** `https://travelsats.ar/.well-known/lnurlp/*`,
  `https://travelsats.ar/.well-known/nostr.json`, and
  `https://travelsats.ar/lnurlp/*` are routed to this app.
- **Spark webhook:** Breez POSTs `SPARK_WEBHOOK_URL` (default
  `${BASE_URL}/spark/webhook`). Until `/spark/webhook` is proxied on
  `travelsats.ar`, set `SPARK_WEBHOOK_URL` to the Fly origin
  (`https://travelsats-alby-lite.fly.dev/spark/webhook`).
- **Direct app URL:** `https://travelsats-alby-lite.fly.dev`

Detailed operational documentation (architecture diagram, Cloudflare Worker
code, secret rotation, troubleshooting, costs, migration history) lives in
the Travelsats main repository:
[`docs/travelsats-lightning-infrastructure.md`](https://github.com/cardugarte/travelsats.ar/blob/development/docs/travelsats-lightning-infrastructure.md).

### Deployment workflow

```bash
# From the fork root (this repository):
fly deploy --remote-only --app travelsats-alby-lite

# Rotating secrets (single restart):
fly secrets set \
  DATABASE_URL="..." \
  ENCRYPTION_KEY="..." \
  NOSTR_NIP57_PRIVATE_KEY="..." \
  --app travelsats-alby-lite

# Tailing logs:
fly logs --app travelsats-alby-lite
```

### Keeping the fork in sync with upstream

```bash
# Add upstream remote (one-time):
git remote add upstream https://github.com/getAlby/lite.git

# Pull and rebase periodically:
git fetch upstream
git rebase upstream/master

# Resolve conflicts (rare — fork has minimal divergence), then push:
git push origin master --force-with-lease
```

When rebasing, watch for upstream changes to `src/db/schema.ts` — although
this fork does not modify the schema today, future Travelsats integration may
extend it (e.g., adding columns mirroring the `names` table). If/when that
happens, document the schema delta in this section.
