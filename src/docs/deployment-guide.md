# Alby Lite Deployment Guide

## Overview

This guide covers deploying Alby Lite (Lightning address server powered by NWC) using:

- **Database:** Supabase (PostgreSQL)
- **Hosting:** Google Cloud Run
- **Environments:** Local, Development, Production

## Prerequisites

- [Deno](https://deno.land/) installed
- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) installed
- [Docker](https://www.docker.com/) installed (for local development)
- Supabase account
- Google Cloud account with billing enabled

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `BASE_URL` | Yes | Public URL of the server |
| `ENCRYPTION_KEY` | Yes | AES-GCM key for encrypting NWC secrets |
| `NOSTR_NIP57_PRIVATE_KEY` | Yes | Private key for signing zap receipts |
| `BREEZ_API_KEY` | Spark | Server-side Breez API key for the minter. Never put this in a client bundle. |
| `SPARK_MINTER_MNEMONIC` | Spark | Minter wallet seed only (invoices + creator webhook). Never a user seed. |
| `SPARK_WEBHOOK_SECRET` | Spark | HMAC secret for `POST /spark/webhook` (`X-Spark-Signature`). After `connect` the minter registers this URL with Breez (`lightningReceiveFinished`) so LUD-21 can persist the preimage. |
| `SPARK_MINTER_STORAGE_DIR` | No | SDK storage directory (default `./.spark-minter`) |
| `LOG_LEVEL` | No | Logging verbosity (DEBUG, INFO, WARN, ERROR) |
| `PORT` | No | Server port (default: 8080) |

Spark and NWC users share the existing Postgres. Do not add a second database.
Do not run Breez's LNURL server alongside this app.

## Local Development

### 1. Start PostgreSQL with Docker

```bash
docker run -d \
  --name postgres-alby \
  -e POSTGRES_USER=myuser \
  -e POSTGRES_PASSWORD=mypass \
  -e POSTGRES_DB=alby_lite \
  -p 5432:5432 \
  postgres:16
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
LOG_LEVEL=DEBUG
BASE_URL=http://localhost:8080
DATABASE_URL=postgresql://myuser:mypass@localhost:5432/alby_lite
ENCRYPTION_KEY=
NOSTR_NIP57_PRIVATE_KEY=
```

### 3. Generate Encryption Key

```bash
deno task db:generate:key
```

Copy the output to `ENCRYPTION_KEY` in `.env`.

### 4. Generate Nostr Private Key

Generate a 64-character hex private key using [nostrtool.com](https://nostrtool.com/) or similar tool.

### 5. Run the Server

```bash
deno task dev
```

### 6. Test the Endpoint

```bash
curl -X POST http://localhost:8080/users \
  -H "Content-Type: application/json" \
  -d '{
    "connectionSecret": "nostr+walletconnect://...",
    "nostrPubkey": "npub..."
  }'
```

## Supabase Setup

### 1. Create a New Project

1. Go to [supabase.com](https://supabase.com)
2. Create a new project
3. Wait for the database to be provisioned

### 2. Get Connection String

1. Go to **Project Settings** > **Database**
2. Copy the **Connection string (URI)**
3. Replace `[YOUR-PASSWORD]` with your database password

Format:

```text
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

### 3. Create Separate Projects for Dev/Prod

For proper environment isolation, create two Supabase projects:

- `alby-lite-dev`
- `alby-lite-prod`

## Google Cloud Run Deployment

### 1. Initial Setup

```bash
# Login to Google Cloud
gcloud auth login

# Set your project
gcloud config set project YOUR_PROJECT_ID

# Enable required services
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
```

### 2. Build and Push Docker Image

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/alby-lite
```

### 3. Deploy to Cloud Run

```bash
gcloud run deploy alby-lite \
  --image gcr.io/YOUR_PROJECT_ID/alby-lite \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 3 \
  --memory 512Mi \
  --set-env-vars "BASE_URL=https://alby-lite-XXXXX-uc.a.run.app" \
  --set-env-vars "DATABASE_URL=postgresql://..." \
  --set-env-vars "ENCRYPTION_KEY=..." \
  --set-env-vars "NOSTR_NIP57_PRIVATE_KEY=..."
```

**Important:** `--min-instances 1` keeps at least one instance running to maintain NWC WebSocket connections.

### 4. Get the Service URL

After deployment, Cloud Run will output the service URL:

```text
Service URL: https://alby-lite-XXXXX-uc.a.run.app
```

Update `BASE_URL` with this URL and redeploy if needed.

## Multi-Environment Setup

### Environment Configuration

| Environment | Database | Cloud Run Service |
|-------------|----------|-------------------|
| Local | Docker PostgreSQL | N/A |
| Development | Supabase (dev project) | `alby-lite-dev` |
| Production | Supabase (prod project) | `alby-lite-prod` |

### Deploy Development

```bash
gcloud run deploy alby-lite-dev \
  --image gcr.io/YOUR_PROJECT_ID/alby-lite \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 2 \
  --memory 512Mi \
  --set-env-vars "BASE_URL=https://alby-lite-dev-XXXXX-uc.a.run.app" \
  --set-env-vars "DATABASE_URL=postgresql://...supabase-dev..." \
  --set-env-vars "ENCRYPTION_KEY=..." \
  --set-env-vars "NOSTR_NIP57_PRIVATE_KEY=..."
```

### Deploy Production

```bash
gcloud run deploy alby-lite-prod \
  --image gcr.io/YOUR_PROJECT_ID/alby-lite \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 5 \
  --memory 512Mi \
  --set-env-vars "BASE_URL=https://your-domain.com" \
  --set-env-vars "DATABASE_URL=postgresql://...supabase-prod..." \
  --set-env-vars "ENCRYPTION_KEY=..." \
  --set-env-vars "NOSTR_NIP57_PRIVATE_KEY=..."
```

## API Reference

### Create User

**Endpoint:** `POST /users`

**Request (NWC):**

```json
{
  "connectionSecret": "nostr+walletconnect://...",
  "nostrPubkey": "npub... or hex pubkey",
  "username": "optional-username"
}
```

**Request (Spark):**

```json
{
  "sparkIdentityPubkey": "02…",
  "nostrPubkey": "npub... or hex pubkey",
  "username": "optional-username"
}
```

**Response:**

```json
{
  "lightningAddress": "username@your-domain.com"
}
```

### Health Check

**Endpoint:** `GET /ping`

**Response:** `OK`

## Cost Estimation

| Service | Free Tier | Estimated Cost |
|---------|-----------|----------------|
| Cloud Run | 2M requests/month | ~$0.40/million requests |
| Cloud Run (min-instances=1) | 50 hours/month | ~$0.05/hour after |
| Supabase | 500MB storage | $25/month (Pro plan) |

**Estimated monthly cost for low/medium usage:** $5-20

## Troubleshooting

### Database Connection Issues

- Verify `DATABASE_URL` format is correct
- Check Supabase dashboard for connection limits
- Ensure IP is not blocked in Supabase settings

### NWC Subscriptions Not Working

- Ensure `--min-instances 1` is set (connections are lost when instance scales to zero)
- Check logs: `gcloud run logs read --service alby-lite`

### Encryption Key Errors

- Generate a new key: `deno task db:generate:key`
- Key must be base64-encoded 256-bit key

## Useful Commands

```bash
# View logs
gcloud run logs read --service alby-lite --limit 50

# Update environment variable
gcloud run services update alby-lite --set-env-vars "LOG_LEVEL=DEBUG"

# Get service details
gcloud run services describe alby-lite

# Delete service
gcloud run services delete alby-lite
```
