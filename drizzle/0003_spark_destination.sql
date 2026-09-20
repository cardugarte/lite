ALTER TABLE "users" ALTER COLUMN "connection_secret" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "destination" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "spark_identity_pubkey" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rebind_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"token_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "rebind_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rebind_tokens_username_idx" ON "rebind_tokens" USING btree ("username");
