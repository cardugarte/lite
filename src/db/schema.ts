import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  encryptedConnectionSecret: text("connection_secret"),
  username: text("username").unique().notNull(),
  nostrPubkey: text("nostr_pubkey").notNull(),
  destination: text("destination").notNull(),
  sparkIdentityPubkey: text("spark_identity_pubkey"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
  mintedBy: text("minted_by").notNull(),
  receiverPubkey: text("receiver_pubkey"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => {
  return {
    userIdIdx: index("user_id_idx").on(table.userId),
    userPaymentHashIdx: index("user_payment_hash_idx").on(table.userId, table.paymentHash),
  };
});

export const bindingIntents = pgTable("binding_intents", {
  username: text("username").primaryKey(),
  nostrPubkey: text("nostr_pubkey").notNull(),
  sparkPubkey: text("spark_pubkey").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  return {
    expiresAtIdx: index("binding_intents_expires_at_idx").on(table.expiresAt),
  };
});

export const signedStatements = pgTable("signed_statements", {
  statementHash: text("statement_hash").primaryKey(),
  route: text("route").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  return {
    expiresAtIdx: index("signed_statements_expires_at_idx").on(table.expiresAt),
  };
});
