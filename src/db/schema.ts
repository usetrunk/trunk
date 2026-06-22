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
  workspaceRole: text("workspace_role"), // admin, member — null when not in a workspace
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
  toRoom: text("to_room").references(() => rooms.id),
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
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("messages_from_idempotency_idx").on(table.fromAgent, table.idempotencyKey),
  index("messages_inbox_idx").on(table.toAgent, table.status, table.createdAt),
  index("messages_thread_idx").on(table.threadId, table.createdAt),
  index("messages_reply_to_idx").on(table.replyTo),
  index("messages_workspace_inbox_idx").on(table.toWorkspace, table.status, table.createdAt),
  index("messages_room_inbox_idx").on(table.toRoom, table.status, table.createdAt),
  index("messages_scheduled_idx").on(table.status, table.scheduledAt),
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
  collaborationRole: text("collaboration_role"), // optional room-specific role, e.g. orchestrator, builder, reviewer
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("room_members_idx").on(table.roomId, table.agentId),
  index("room_members_agent_idx").on(table.agentId),
]);

export const agentDelegations = pgTable("agent_delegations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  parentAgentId: text("parent_agent_id").notNull().references(() => agents.id),
  childAgentId: text("child_agent_id").references(() => agents.id),
  roomId: text("room_id").notNull().references(() => rooms.id),
  taskId: text("task_id").references(() => tasks.id),
  relationship: text("relationship").notNull().default("delegated_worker"),
  runtime: text("runtime").notNull().default("custom"),
  name: text("name").notNull(),
  collaborationRole: text("collaboration_role"),
  tokenHash: text("token_hash").notNull(),
  tokenId: text("token_id").notNull().unique(),
  status: text("status").notNull().default("open"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  runtimeSessionRef: text("runtime_session_ref"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("agent_delegations_parent_idx").on(table.parentAgentId, table.createdAt),
  index("agent_delegations_child_idx").on(table.childAgentId, table.createdAt),
  index("agent_delegations_room_idx").on(table.roomId, table.status),
  index("agent_delegations_task_idx").on(table.taskId),
  index("agent_delegations_token_idx").on(table.tokenHash),
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

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  messageId: text("message_id").references(() => messages.id),
  url: text("url").notNull(),
  event: text("event").notNull(), // message.received, webhook.test, etc.
  success: integer("success").notNull(), // 1 = success, 0 = failure (boolean via integer for portability)
  httpStatus: integer("http_status"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("webhook_deliveries_agent_idx").on(table.agentId, table.createdAt),
]);

export const contactNotes = pgTable("contact_notes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  contactAgentId: text("contact_agent_id").notNull().references(() => agents.id),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("contact_notes_agent_idx").on(table.agentId, table.contactAgentId),
]);

export const blockedContacts = pgTable("blocked_contacts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  blockedAgentId: text("blocked_agent_id").notNull().references(() => agents.id),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("blocked_contacts_unique_idx").on(table.agentId, table.blockedAgentId),
  index("blocked_contacts_agent_idx").on(table.agentId),
]);

export const messageLabels = pgTable("message_labels", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id").notNull().references(() => messages.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("message_labels_unique_idx").on(table.messageId, table.agentId, table.label),
  index("message_labels_agent_idx").on(table.agentId, table.label),
  index("message_labels_message_idx").on(table.messageId),
]);

export const messageTemplates = pgTable("message_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  name: text("name").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("message_templates_agent_name_idx").on(table.agentId, table.name),
  index("message_templates_agent_idx").on(table.agentId),
]);

export const savedSearches = pgTable("saved_searches", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  name: text("name").notNull(),
  query: jsonb("query").$type<Record<string, string>>().notNull(), // { q?, type?, contact?, after?, before? }
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("saved_searches_agent_name_idx").on(table.agentId, table.name),
  index("saved_searches_agent_idx").on(table.agentId),
]);

export const messageEdits = pgTable("message_edits", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id").notNull().references(() => messages.id),
  version: integer("version").notNull(),
  previousPayload: jsonb("previous_payload").$type<Record<string, unknown>>().notNull(),
  editedBy: text("edited_by").notNull().references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("message_edits_message_idx").on(table.messageId, table.version),
]);

export const contactTags = pgTable("contact_tags", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  contactAgentId: text("contact_agent_id").notNull().references(() => agents.id),
  tag: text("tag").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("contact_tags_unique_idx").on(table.agentId, table.contactAgentId, table.tag),
  index("contact_tags_agent_idx").on(table.agentId, table.tag),
  index("contact_tags_contact_idx").on(table.agentId, table.contactAgentId),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agents.id),
  contactAgentId: text("contact_agent_id").notNull().references(() => agents.id),
  muted: integer("muted").notNull().default(0), // 0 = not muted, 1 = muted
  urgencyFilter: text("urgency_filter").notNull().default("all"), // all, sync_only
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("notification_prefs_unique_idx").on(table.agentId, table.contactAgentId),
  index("notification_prefs_agent_idx").on(table.agentId),
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

export const roomWebhooks = pgTable("room_webhooks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  roomId: text("room_id").notNull().references(() => rooms.id),
  url: text("url").notNull(),
  secret: text("secret"),
  filterGroup: text("filter_group"), // null = match all groups
  filterPriority: text("filter_priority"), // null = match all priorities
  filterStatus: text("filter_status"), // null = match all statuses
  active: integer("active").notNull().default(1), // 1 = active, 0 = inactive
  createdBy: text("created_by").notNull().references(() => agents.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("room_webhooks_room_idx").on(table.roomId),
]);

export const attachments = pgTable("attachments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id").references(() => messages.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull().default("application/octet-stream"),
  sizeBytes: integer("size_bytes").notNull(),
  data: text("data").notNull(), // base64-encoded content
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("attachments_message_idx").on(table.messageId),
  index("attachments_agent_idx").on(table.agentId, table.createdAt),
]);

export const agentCards = pgTable("agent_cards", {
  agentId: text("agent_id").primaryKey().references(() => agents.id),
  schema: text("schema").notNull().default("trunk.agent_card.v1"),
  description: text("description"),
  protocol: jsonb("protocol").$type<string[]>().notNull().default([]),
  version: text("version").notNull().default("0.1.0"),
  homepageUrl: text("homepage_url"),
  documentationUrl: text("documentation_url"),
  repositoryUrl: text("repository_url"),
  capabilities: jsonb("capabilities").$type<Array<Record<string, unknown>>>().notNull().default([]),
  messageTypes: jsonb("message_types").$type<string[]>().notNull().default([]),
  endpoints: jsonb("endpoints").$type<Array<Record<string, unknown>>>().notNull().default([]),
  contactPolicy: jsonb("contact_policy").$type<Record<string, unknown>>().notNull().default({}),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scopedGrants = pgTable("scoped_grants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  ownerAgentId: text("owner_agent_id").notNull().references(() => agents.id),
  createdBy: text("created_by").references(() => agents.id),
  name: text("name").notNull(),
  description: text("description"),
  tokenHash: text("token_hash").notNull(),
  tokenId: text("token_id").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  audienceAgentId: text("audience_agent_id").references(() => agents.id),
  audienceWorkspaceId: text("audience_workspace_id").references(() => workspaces.id),
  roomId: text("room_id").references(() => rooms.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  notBefore: timestamp("not_before", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  useCount: integer("use_count").notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("scoped_grants_owner_idx").on(table.ownerAgentId, table.createdAt),
  index("scoped_grants_audience_idx").on(table.audienceAgentId),
]);

export const factHistory = pgTable("fact_history", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  setBy: text("set_by").notNull().references(() => agents.id),
  setAt: timestamp("set_at", { withTimezone: true }).defaultNow().notNull(),
  reason: text("reason"),
  sourceMessageId: text("source_message_id").references(() => messages.id),
  sourceThreadId: text("source_thread_id"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  supersededBy: text("superseded_by").references(() => agents.id),
}, (table) => [
  index("fact_history_scope_key_idx").on(table.scope, table.key, table.version),
  index("fact_history_set_by_idx").on(table.setBy, table.setAt),
  index("fact_history_source_msg_idx").on(table.sourceMessageId),
]);
