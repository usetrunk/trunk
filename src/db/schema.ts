import { pgTable, text, timestamp, date, jsonb, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  owner: text("owner"),
  pairingCode: text("pairing_code").notNull().unique(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  owner: text("owner"),
  secretHash: text("secret_hash").notNull(),
  pairingCode: text("pairing_code").notNull().unique(),
  webhookUrl: text("webhook_url"),
  webhookSecret: text("webhook_secret"),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("agents_workspace_idx").on(table.workspaceId),
]);

export const contacts = pgTable("contacts", {
  agentA: text("agent_a").notNull().references(() => agents.id),
  agentB: text("agent_b").notNull().references(() => agents.id),
  aliasA: text("alias_a"),
  aliasB: text("alias_b"),
  pairedAt: timestamp("paired_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("contacts_pair_idx").on(table.agentA, table.agentB),
]);

export const workspaceContacts = pgTable("workspace_contacts", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  alias: text("alias"),
  pairedAt: timestamp("paired_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("workspace_contacts_idx").on(table.workspaceId, table.agentId),
  index("workspace_contacts_agent_idx").on(table.agentId),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fromAgent: text("from_agent").notNull().references(() => agents.id),
  toAgent: text("to_agent").notNull().references(() => agents.id),
  toWorkspace: text("to_workspace").references(() => workspaces.id),
  threadId: text("thread_id"),
  replyTo: text("reply_to"),
  idempotencyKey: text("idempotency_key"),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  pinnedBy: text("pinned_by"),
}, (table) => [
  uniqueIndex("messages_from_idempotency_idx").on(table.fromAgent, table.idempotencyKey),
  index("messages_inbox_idx").on(table.toAgent, table.status, table.createdAt),
  index("messages_thread_idx").on(table.threadId, table.createdAt),
  index("messages_reply_to_idx").on(table.replyTo),
  index("messages_workspace_inbox_idx").on(table.toWorkspace, table.status, table.createdAt),
]);

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull().references(() => agents.id),
  pairingCode: text("pairing_code").notNull().unique(), // join code for the room
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const roomMembers = pgTable("room_members", {
  roomId: text("room_id").notNull().references(() => rooms.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  role: text("role").notNull().default("member"), // creator, admin, member
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("room_members_idx").on(table.roomId, table.agentId),
  index("room_members_agent_idx").on(table.agentId),
]);

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  scope: text("scope").notNull(), // "contact:<a>-<b>", "room:<id>", or "self:<id>"
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"), // open, in-progress, done, blocked
  priority: text("priority").notNull().default("medium"), // critical, high, medium, low
  owner: text("owner").references(() => agents.id),
  createdBy: text("created_by").notNull().references(() => agents.id),
  due: date("due"),
  startDate: date("start_date"), // for Gantt: when work begins
  group: text("group"), // module/epic grouping (e.g., "payments", "auth", "onboarding")
  dependsOn: jsonb("depends_on").$type<string[]>().default([]), // array of task IDs that must be done first
  sequence: integer("sequence"), // ordering within a group
  estimate: integer("estimate"), // estimated hours/days for Gantt bar width
  contextRef: text("context_ref"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("tasks_scope_idx").on(table.scope, table.status),
  index("tasks_owner_idx").on(table.owner, table.status),
  index("tasks_group_idx").on(table.scope, table.group),
]);

export const sharedFacts = pgTable("shared_facts", {
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull().references(() => agents.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shared_facts_scope_key_idx").on(table.scope, table.key),
]);

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  actorAgent: text("actor_agent").references(() => agents.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("audit_events_actor_idx").on(table.actorAgent, table.createdAt),
  index("audit_events_target_idx").on(table.targetType, table.targetId),
]);

export const rateLimits = pgTable("rate_limits", {
  scope: text("scope").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sharedDocuments = pgTable("shared_documents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  scope: text("scope").notNull(), // "contact:<a>-<b>" or "room:<id>"
  name: text("name").notNull(),
  contentType: text("content_type").notNull().default("text/markdown"),
  body: text("body").notNull(),
  version: integer("version").notNull().default(1),
  lastEditedBy: text("last_edited_by").notNull().references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shared_docs_scope_idx").on(table.scope, table.name),
]);

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id).unique(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  plan: text("plan").notNull().default("free"), // free, team
  status: text("status").notNull().default("active"), // active, canceled, past_due, trialing
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("subscriptions_stripe_customer_idx").on(table.stripeCustomerId),
  index("subscriptions_stripe_sub_idx").on(table.stripeSubscriptionId),
]);

export const reactions = pgTable("reactions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id").notNull().references(() => messages.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("reactions_unique_idx").on(table.messageId, table.agentId, table.emoji),
  index("reactions_message_idx").on(table.messageId),
]);

export const sharedDocumentVersions = pgTable("shared_document_versions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  documentId: text("document_id").notNull().references(() => sharedDocuments.id),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  editedBy: text("edited_by").notNull().references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shared_doc_versions_idx").on(table.documentId, table.version),
]);
