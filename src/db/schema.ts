import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  // NULL for spark users. NULL destination also means nwc.
  encryptedConnectionSecret: text("connection_secret"),
  username: text("username").unique().notNull(),
  nostrPubkey: text("nostr_pubkey").notNull(),
  destination: text("destination"),
  sparkIdentityPubkey: text("spark_identity_pubkey"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const rebindTokens = pgTable("rebind_tokens", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  tokenHash: text("token_hash").unique().notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => {
  return {
    usernameIdx: index("rebind_tokens_username_idx").on(table.username),
  };
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  amount: bigint("amount", { mode: "number" }).notNull(),
  description: text("description"),
  paymentRequest: text("payment_request").unique().notNull(),
  paymentHash: text("payment_hash").unique().notNull(),
  preimage: text("preimage"),
  metadata: jsonb("metadata"),
  settledAt: timestamp("settled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => {
  return {
    userIdIdx: index("user_id_idx").on(table.userId),
    userPaymentHashIdx: index("user_payment_hash_idx").on(table.userId, table.paymentHash),
  };
});
