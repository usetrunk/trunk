import { pgTable, text, timestamp, jsonb, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  owner: text("owner"),
  secretHash: text("secret_hash").notNull(),
  pairingCode: text("pairing_code").notNull().unique(),
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const contacts = pgTable("contacts", {
  agentA: text("agent_a").notNull().references(() => agents.id),
  agentB: text("agent_b").notNull().references(() => agents.id),
  aliasA: text("alias_a"),
  aliasB: text("alias_b"),
  pairedAt: timestamp("paired_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("contacts_pair_idx").on(table.agentA, table.agentB),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fromAgent: text("from_agent").notNull().references(() => agents.id),
  toAgent: text("to_agent").notNull().references(() => agents.id),
  threadId: text("thread_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
}, (table) => [
  index("messages_inbox_idx").on(table.toAgent, table.status, table.createdAt),
  index("messages_thread_idx").on(table.threadId, table.createdAt),
]);
