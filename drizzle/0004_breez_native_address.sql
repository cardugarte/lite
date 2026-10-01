DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE connection_secret IS NOT NULL AND spark_identity_pubkey IS NOT NULL) THEN
    RAISE EXCEPTION '0004: a users row holds both credentials; resolve by hand';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE connection_secret IS NULL AND spark_identity_pubkey IS NULL) THEN
    RAISE EXCEPTION '0004: a users row holds no credential; resolve by hand';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE destination = 'spark' AND spark_identity_pubkey IS NULL) THEN
    RAISE EXCEPTION '0004: destination spark without a spark pubkey';
  END IF;
  IF EXISTS (SELECT lower(username) FROM users GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0004: usernames collide when lowercased';
  END IF;
  IF EXISTS (SELECT lower(nostr_pubkey) FROM users WHERE nostr_pubkey <> '' GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0004: more than one row per nostr pubkey';
  END IF;
  IF EXISTS (SELECT lower(spark_identity_pubkey) FROM users WHERE spark_identity_pubkey IS NOT NULL GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0004: spark pubkey bound to more than one row';
  END IF;
END $$;
--> statement-breakpoint
UPDATE users SET
  destination = CASE WHEN spark_identity_pubkey IS NOT NULL THEN 'spark' ELSE 'nwc' END,
  username = lower(username),
  nostr_pubkey = lower(nostr_pubkey),
  spark_identity_pubkey = lower(spark_identity_pubkey);
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN destination SET NOT NULL;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_destination_xor CHECK (
  (destination = 'nwc'   AND connection_secret IS NOT NULL AND spark_identity_pubkey IS NULL) OR
  (destination = 'spark' AND spark_identity_pubkey IS NOT NULL AND connection_secret IS NULL));
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_spark_pubkey_format
  CHECK (spark_identity_pubkey IS NULL OR spark_identity_pubkey ~ '^0[23][0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_username_lowercase CHECK (username = lower(username));
--> statement-breakpoint
CREATE UNIQUE INDEX users_nostr_pubkey_unique ON users (nostr_pubkey) WHERE nostr_pubkey <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX users_spark_identity_pubkey_unique ON users (spark_identity_pubkey)
  WHERE spark_identity_pubkey IS NOT NULL;
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN minted_by text;
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN receiver_pubkey text;
--> statement-breakpoint
UPDATE invoices i SET
  minted_by = u.destination,
  receiver_pubkey = CASE WHEN u.destination = 'spark' THEN u.spark_identity_pubkey END
FROM users u WHERE u.id = i.user_id;
--> statement-breakpoint
ALTER TABLE invoices ALTER COLUMN minted_by SET NOT NULL;
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_minted_by_receiver CHECK (
  (minted_by = 'nwc' AND receiver_pubkey IS NULL) OR
  (minted_by = 'spark' AND receiver_pubkey IS NOT NULL));
--> statement-breakpoint
DROP TABLE IF EXISTS rebind_tokens;
--> statement-breakpoint
CREATE TABLE binding_intents (
  username text PRIMARY KEY CHECK (username = lower(username)),
  nostr_pubkey text NOT NULL,
  spark_pubkey text NOT NULL CHECK (spark_pubkey ~ '^0[23][0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE INDEX binding_intents_expires_at_idx ON binding_intents (expires_at);
--> statement-breakpoint
CREATE TABLE signed_statements (
  statement_hash text PRIMARY KEY,
  route text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
--> statement-breakpoint
CREATE INDEX signed_statements_expires_at_idx ON signed_statements (expires_at);
