ALTER TABLE users DROP CONSTRAINT IF EXISTS users_destination_xor;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_spark_pubkey_format;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_lowercase;
--> statement-breakpoint
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_minted_by_receiver;
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN destination DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE invoices ALTER COLUMN minted_by DROP NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS users_nostr_pubkey_unique;
--> statement-breakpoint
DROP INDEX IF EXISTS users_spark_identity_pubkey_unique;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rebind_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"token_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "rebind_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rebind_tokens_username_idx" ON "rebind_tokens" USING btree ("username");
