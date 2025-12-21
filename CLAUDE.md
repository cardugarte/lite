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
