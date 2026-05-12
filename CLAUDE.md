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
- **users.ts**: User registration endpoint (`POST /users`)
- **lnurlp.ts**: LNURL-pay callback and verification endpoints
- **nwc/nwcPool.ts**: Manages NWC client subscriptions for all users, handles payment notifications and zap publishing
- **well-known/**: Serves `.well-known/lnurlp` and `.well-known/nostr.json` endpoints

### Database

Uses Drizzle ORM with PostgreSQL:
- **schema.ts**: Defines `users` and `invoices` tables
- **db.ts**: Database operations (create/find users, manage invoices)
- **aesgcm.ts**: AES-GCM encryption for NWC connection secrets

### Key Flow

1. User registers with NWC connection secret and Nostr pubkey via `POST /users`
2. NWCPool subscribes to payment notifications for the user's wallet
3. When someone pays to the Lightning address, the callback creates an invoice via NWC
4. On payment received, NWCPool marks invoice settled and publishes zap receipt to Nostr relays

## Environment Variables

Required in `.env` (see `.env.example`):
- `DATABASE_URL`: PostgreSQL connection string
- `ENCRYPTION_KEY`: For encrypting NWC secrets (generate with `deno task db:generate:key`)
- `NOSTR_NIP57_PRIVATE_KEY`: Zapper service private key for signing zap receipts
- `BASE_URL`: Public URL of the server
- `LOG_LEVEL`: Logging verbosity

---

## Fork-Specific: TravelSats Deployment

This repository is a fork of [`getAlby/lite`](https://github.com/getAlby/lite)
maintained for the TravelSats platform deployment.

### Differences from upstream

This fork is a minimal extension of upstream and currently carries only the
following changes:

1. **`fix: copy drizzle migrations folder in Docker image`** (commit `2adf193`)
   — ensures the `drizzle/` directory is present in the runtime image so the
   migrator can find `meta/_journal.json` on startup. Likely candidate for an
   upstream PR.
2. **`chore(fly): adapt configuration for TravelSats deployment`** (commit
   `993e393`) and **`chore(fly): switch primary region from gru to iad`**
   (commit `aa4c556`) — `fly.toml` parameters tuned for the production
   TravelSats deployment (app name, region, memory, healthcheck grace,
   `min_machines_running=1` to preserve NWC subscriptions).
3. **`docs: add CLAUDE.md and deployment guide`** (commit `0392ced`) — this
   file plus initial deployment notes (the original GCP-era guide is
   superseded by the TravelSats infrastructure doc linked below).

No code changes to `src/`, `db/schema.ts`, or business logic. The upstream
public API surface is preserved.

### Production environment

- **Platform:** Fly.io
- **App name:** `travelsats-alby-lite`
- **Primary region:** `iad` (Ashburn, Virginia, US East)
- **Public URL via Cloudflare Worker:** `https://travelsats.ar/.well-known/lnurlp/*`,
  `https://travelsats.ar/.well-known/nostr.json`, and
  `https://travelsats.ar/lnurlp/*` are routed to this app.
- **Direct app URL:** `https://travelsats-alby-lite.fly.dev`

Detailed operational documentation (architecture diagram, Cloudflare Worker
code, secret rotation, troubleshooting, costs, migration history) lives in
the TravelSats main repository:
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
this fork does not modify the schema today, future TravelSats integration may
extend it (e.g., adding columns mirroring the `names` table). If/when that
happens, document the schema delta in this section.
