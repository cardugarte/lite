-- The Spark minter keeps its SDK state in Postgres, in its own schema, so a
-- redeploy of the container never loses it and it never mixes with `public`.
CREATE SCHEMA IF NOT EXISTS breez_minter;
