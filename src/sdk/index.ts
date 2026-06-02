import { signTrunkWebhook, verifyTrunkWebhook } from "../lib/verify-webhook.js";

export type TrunkMessageType =
  | "question"
  | "decision"
  | "review"
  | "handoff"
  | "update"
  | "ack"
  | (string & {});

export type TrunkPayload = Record<string, unknown>;

export type RegisterRequest = {
  name: string;
  owner?: string;
  webhook_url?: string;
};

export type RegisterResponse = {
  agent_id: string;
  name: string;
  secret: string;
  pairing_code: string;
  webhook_secret: string;
  webhook_url?: string | null;
};

export type AgentProfile = {
  agent_id: string;
  name: string;
  owner?: string | null;
  pairing_code?: string;
  webhook_url?: string | null;
  role?: string;
  projects?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string | Date;
};

export type UpdateMeRequest = {
  name?: string;
  owner?: string;
  webhook_url?: string;
  role?: string;
  projects?: string[];
  metadata?: Record<string, unknown>;
};

export type RotateSecretResponse = {
  secret: string;
};

export type WebhookTestResponse = {
  ok: boolean;
  status?: number;
  webhook_url: string;
  latency_ms?: number;
  message: string;
};

export type WebhookConfigResponse = {
  url: string | null;
  secret_hint: string | null;
  configured: boolean;
};

export type WebhookRotateSecretResponse = {
  webhook_secret: string;
  message: string;
};

export type WebhookDelivery = {
  id: string;
  message_id: string | null;
  url: string;
  event: string;
  success: boolean;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  attempts: number;
  created_at: string | Date;
};

export type WebhookDeliveriesResponse = {
  deliveries: WebhookDelivery[];
  count: number;
};

export type PairRequest = {
  code: string;
  alias?: string;
};

export type PairResponse = {
  contact_id?: string;
  name?: string;
  contact_type: "agent" | "workspace";
  workspace_id?: string;
  workspace_name?: string;
  members?: Array<{ agent_id: string; name: string; owner?: string | null }>;
  paired_at: string;
};

export type CreateWorkspaceRequest = {
  name: string;
  owner?: string;
};

export type WorkspaceResponse = {
  id: string;
  name: string;
  owner?: string | null;
  pairing_code: string;
  created_at: string | Date;
};

export type WorkspaceJoinRequest = {
  code: string;
};

export type WorkspaceJoinResponse = {
  joined: boolean;
  workspace_id: string;
  name: string;
};

export type WorkspaceInfo = {
  workspace: WorkspaceResponse;
  members: Array<{ agent_id: string; name: string; owner?: string | null }>;
};

export type WorkspaceMembersResponse = {
  members: Array<{ agent_id: string; name: string; owner?: string | null }>;
};

export type PresenceMember = {
  agent_id: string;
  name: string;
  owner?: string | null;
  role?: string;
  status: "online" | "away" | "offline";
  last_seen_at: string | Date | null;
};

export type PresenceResponse = {
  workspace_id: string;
  members: PresenceMember[];
  online: number;
  away: number;
  offline: number;
};

export type Contact = {
  agent_id: string;
  name: string;
  owner?: string | null;
  paired_at: string | Date;
};

export type ContactsResponse = {
  contacts: Contact[];
};

export type SendMessageRequest = {
  to: string;
  type: TrunkMessageType;
  payload: TrunkPayload;
  thread_id?: string;
  reply_to?: string;
  idempotency_key?: string;
  scheduled_at?: string;
};

export type MessageReceipt = {
  id: string;
  thread_id: string;
  status: string;
  created_at: string | Date;
  recipients?: number;
  scheduled_at?: string;
};

export type TrunkMessage = {
  id: string;
  fromAgent: string;
  toAgent: string;
  threadId: string | null;
  replyTo?: string | null;
  idempotencyKey?: string | null;
  type: string;
  payload: TrunkPayload;
  status: string;
  createdAt: string | Date;
  readAt?: string | Date | null;
  deliveredAt?: string | Date | null;
  processedAt?: string | Date | null;
  repliedAt?: string | Date | null;
  deletedAt?: string | Date | null;
};

export type CreateTaskRequest = {
  contact_id?: string;
  room_id?: string;
  workspace_id?: string;
  title: string;
  description?: string;
  priority?: "critical" | "high" | "medium" | "low";
  owner?: string;
  due?: string;
  start_date?: string;
  group?: string;
  depends_on?: string[];
  sequence?: number;
  estimate?: number;
  context_ref?: string;
  metadata?: Record<string, unknown>;
};

export type TaskResponse = {
  id: string;
  scope?: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  owner: string | null;
  created_by: string;
  due: string | null;
  start_date: string | null;
  group: string | null;
  depends_on: string[];
  sequence: number | null;
  estimate: number | null;
  context_ref: string | null;
  created_at: string | Date;
  updated_at?: string | Date;
};

export type TaskListResponse = {
  tasks: TaskResponse[];
};

export type GanttTask = TaskResponse & {
  owner_name: string | null;
  deps_met: boolean;
  blocked_by: string[];
};

export type GanttResponse = {
  tasks: GanttTask[];
  groups: Record<string, GanttTask[]>;
  ungrouped: GanttTask[];
  summary: {
    total: number;
    done: number;
    in_progress: number;
    blocked: number;
    open: number;
  };
};

export type UpdateTaskRequest = {
  title?: string;
  description?: string;
  status?: string;
  priority?: "critical" | "high" | "medium" | "low";
  owner?: string;
  due?: string;
  start_date?: string;
  group?: string;
  depends_on?: string[];
  sequence?: number;
  estimate?: number;
  context_ref?: string;
  metadata?: Record<string, unknown>;
};

export type TaskListOptions = {
  status?: string;
  owner?: string;
  group?: string;
  limit?: number;
  cursor?: string;
};

export type CreateRoomRequest = {
  name: string;
  metadata?: Record<string, unknown>;
};

export type RoomResponse = {
  id: string;
  name: string;
  pairing_code: string;
  created_by?: string;
  created_at?: string | Date;
};

export type JoinRoomRequest = {
  code: string;
};

export type JoinRoomResponse = {
  joined: boolean;
  already_member?: boolean;
  room_id: string;
  name: string;
};

export type RoomListResponse = {
  rooms: Array<RoomResponse & { role?: string }>;
};

export type RoomMember = {
  id: string;
  name: string;
  owner?: string | null;
  role?: string;
  joined_at?: string | Date;
};

export type RoomMembersResponse = {
  members: RoomMember[];
};

export type CreateDocumentRequest = {
  name: string;
  body: string;
  content_type?: string;
};

export type DocumentResponse = {
  id: string;
  name: string;
  content_type: string;
  body?: string;
  version: number;
  last_edited_by: string;
  created_at?: string | Date;
  updated_at?: string | Date;
};

export type DocumentListResponse = {
  documents: DocumentResponse[];
};

export type UpdateDocumentRequest = {
  body: string;
  name?: string;
};

export type DocumentVersionSummary = {
  version: number;
  edited_by: string;
  created_at: string | Date;
  body_length: number;
};

export type DocumentVersionsResponse = {
  versions: DocumentVersionSummary[];
};

export type DocumentVersionResponse = {
  version: number;
  body: string;
  edited_by: string;
  created_at: string | Date;
};

export type BillingStatus = {
  workspace_id: string;
  plan: string;
  status: string;
  current_period_start: string | Date | null;
  current_period_end: string | Date | null;
  stripe_customer_id: string | null;
};

export type CheckoutResponse = {
  url: string;
  session_id: string;
};

export type PortalResponse = {
  url: string;
};

export type InboxOptions = {
  status?: string;
  limit?: number;
  cursor?: string;
};

export type SentOptions = {
  to?: string;
  type?: string;
  limit?: number;
  cursor?: string;
};

export type SearchOptions = {
  q?: string;
  type?: string;
  contact?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
};

export type PaginatedResponse<T> = T & {
  next_cursor: string | null;
  has_more: boolean;
};

export type MessagesResponse = {
  messages: TrunkMessage[];
};

export type ThreadSummaryParticipant = {
  agent_id: string;
  name: string;
  owner?: string | null;
};

export type ThreadSummaryResponse = {
  thread_id: string;
  message_count: number;
  participants: ThreadSummaryParticipant[];
  by_type: Record<string, number>;
  by_status: Record<string, number>;
  decisions: Array<{ id: string; type: string; from: string; content: string | null; created_at: string | Date }>;
  open_questions: Array<{ id: string; from: string; content: string | null; created_at: string | Date }>;
  first_message: { id: string; type: string; from: string; created_at: string | Date };
  last_message: { id: string; type: string; from: string; content: string | null; created_at: string | Date };
  started_at: string | Date;
  last_activity: string | Date;
};

export type AckResponse = {
  ok: true;
};

export type AuditEvent = {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string | Date;
};

export type AuditLogOptions = {
  action?: string;
  target_type?: string;
  target_id?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
};

export type AuditLogResponse = {
  events: AuditEvent[];
};

export type TrunkClientOptions = {
  baseUrl: string;
  secret?: string;
  fetch?: typeof fetch;
};

export class TrunkApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: unknown, retryAfterSeconds?: number) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Trunk API request failed with status ${status}`;
    super(message);
    this.name = "TrunkApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export class TrunkClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private secret?: string;

  constructor(options: TrunkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.secret = options.secret;
    this.fetchImpl = options.fetch ?? fetch;
  }

  setSecret(secret: string): void {
    this.secret = secret;
  }

  register(input: RegisterRequest): Promise<RegisterResponse> {
    return this.request("/agents/register", { method: "POST", body: input, auth: false });
  }

  me(): Promise<AgentProfile> {
    return this.request("/agents/me");
  }

  updateMe(input: UpdateMeRequest): Promise<AgentProfile> {
    return this.request("/agents/me", { method: "PATCH", body: input });
  }

  rotateSecret(): Promise<RotateSecretResponse> {
    return this.request("/agents/me/rotate-secret", { method: "POST" });
  }

  webhookConfig(): Promise<WebhookConfigResponse> {
    return this.request("/agents/me/webhook");
  }

  updateWebhook(url: string): Promise<WebhookConfigResponse> {
    return this.request("/agents/me/webhook", { method: "PUT", body: { url } });
  }

  removeWebhook(): Promise<AckResponse> {
    return this.request("/agents/me/webhook", { method: "DELETE" });
  }

  rotateWebhookSecret(): Promise<WebhookRotateSecretResponse> {
    return this.request("/agents/me/webhook/rotate-secret", { method: "POST" });
  }

  webhookDeliveries(options: { limit?: number } = {}): Promise<WebhookDeliveriesResponse> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    const query = search.toString();
    return this.request(`/agents/me/webhook/deliveries${query ? `?${query}` : ""}`);
  }

  testWebhook(): Promise<WebhookTestResponse> {
    return this.request("/agents/me/webhook/test", { method: "POST" });
  }

  profile(agentId: string): Promise<AgentProfile> {
    return this.request(`/agents/${encodeURIComponent(agentId)}`);
  }

  presence(): Promise<PresenceResponse> {
    return this.request("/agents/presence");
  }

  pair(input: PairRequest): Promise<PairResponse> {
    return this.request("/contacts/pair", { method: "POST", body: input });
  }

  createWorkspace(input: CreateWorkspaceRequest): Promise<WorkspaceResponse> {
    return this.request("/workspaces", { method: "POST", body: input });
  }

  joinWorkspace(input: WorkspaceJoinRequest): Promise<WorkspaceJoinResponse> {
    return this.request("/workspaces/join", { method: "POST", body: input });
  }

  myWorkspace(): Promise<WorkspaceInfo> {
    return this.request("/workspaces/me");
  }

  leaveWorkspace(): Promise<AckResponse> {
    return this.request("/workspaces/leave", { method: "POST" });
  }

  workspaceMembers(workspaceId: string): Promise<WorkspaceMembersResponse> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
  }

  contacts(): Promise<ContactsResponse> {
    return this.request("/contacts");
  }

  updateContactAlias(agentId: string, alias: string | null): Promise<{ ok: boolean; alias: string | null }> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}`, { method: "PATCH", body: { alias } });
  }

  unpair(agentId: string): Promise<AckResponse> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}`, { method: "DELETE" });
  }

  send(input: SendMessageRequest): Promise<MessageReceipt> {
    return this.request("/messages", { method: "POST", body: input });
  }

  scheduledMessages(options: { limit?: number; cursor?: string } = {}): Promise<PaginatedResponse<MessagesResponse>> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/messages/scheduled${query ? `?${query}` : ""}`);
  }

  cancelScheduled(messageId: string): Promise<AckResponse & { message_id: string }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/cancel`, { method: "POST", body: {} });
  }

  deliverScheduled(): Promise<{ delivered: number; checked_at: string }> {
    return this.request("/messages/deliver-scheduled", { method: "POST", body: {} });
  }

  inbox(options: InboxOptions = {}): Promise<PaginatedResponse<MessagesResponse>> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/messages/inbox${query ? `?${query}` : ""}`);
  }

  inboxStats(): Promise<{ unread: number; total: number; by_type: Record<string, number>; by_status: Record<string, number> }> {
    return this.request("/messages/inbox/stats");
  }

  sent(options: SentOptions = {}): Promise<PaginatedResponse<MessagesResponse>> {
    const search = new URLSearchParams();
    if (options.to) search.set("to", options.to);
    if (options.type) search.set("type", options.type);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/messages/sent${query ? `?${query}` : ""}`);
  }

  search(options: SearchOptions = {}): Promise<PaginatedResponse<MessagesResponse>> {
    const search = new URLSearchParams();
    if (options.q) search.set("q", options.q);
    if (options.type) search.set("type", options.type);
    if (options.contact) search.set("contact", options.contact);
    if (options.after) search.set("after", options.after);
    if (options.before) search.set("before", options.before);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/messages/search${query ? `?${query}` : ""}`);
  }

  thread(threadId: string): Promise<MessagesResponse> {
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}`);
  }

  threadSummary(threadId: string): Promise<ThreadSummaryResponse> {
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}/summary`);
  }

  ack(messageId: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST" });
  }

  ackBulk(messageIds: string[]): Promise<{ ok: true; acked: number }> {
    return this.request("/messages/ack-bulk", { method: "POST", body: { message_ids: messageIds } });
  }

  reply(messageId: string, input: Omit<SendMessageRequest, "to" | "thread_id">): Promise<MessageReceipt> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      body: input,
      idempotencyKey: input.idempotency_key,
    });
  }

  listFacts(contactId: string): Promise<{ facts: Array<{ key: string; value: unknown; version: number; updated_by: string; updated_at: string }> }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts`);
  }

  getFact(contactId: string, key: string): Promise<{ key: string; value: unknown; version: number; updated_by: string; updated_at?: string | Date }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`);
  }

  putFact(contactId: string, key: string, value: unknown, options: { ifMatch?: string | number } = {}): Promise<{ key: string; value: unknown; version: number; updated_by: string }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
      ifMatch: options.ifMatch === undefined ? undefined : String(options.ifMatch),
    });
  }

  deleteFact(contactId: string, key: string): Promise<AckResponse> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  editMessage(messageId: string, payload: Record<string, unknown>): Promise<{ id: string; thread_id: string; payload: Record<string, unknown>; edited_at: string; status: string }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: { payload } });
  }

  deleteMessage(messageId: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  }

  purgeExpiredMessages(days = 90): Promise<{ purged: number; cutoff: string }> {
    return this.request("/messages/purge-expired", { method: "POST", body: { days } });
  }

  forward(messageId: string, to: string, comment?: string): Promise<SendResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/forward`, { method: "POST", body: { to, comment } });
  }

  react(messageId: string, emoji: string): Promise<{ id: string; message_id: string; emoji: string; created_at: string }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/react`, { method: "POST", body: { emoji } });
  }

  unreact(messageId: string, emoji: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/react/${encodeURIComponent(emoji)}`, { method: "DELETE" });
  }

  reactions(messageId: string): Promise<{ message_id: string; reactions: Array<{ id: string; emoji: string; agent_id: string; created_at: string }>; summary: Record<string, { count: number; agents: string[] }> }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/reactions`);
  }

  pin(messageId: string): Promise<{ ok: true; pinned_at: string; pinned_by: string }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/pin`, { method: "POST" });
  }

  unpin(messageId: string): Promise<{ ok: true }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/unpin`, { method: "POST" });
  }

  threadPins(threadId: string): Promise<{ thread_id: string; pinned: Array<{ id: string; from: string; type: string; payload: Record<string, unknown>; pinned_at: string; pinned_by: string | null; created_at: string }>; count: number }> {
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}/pins`);
  }

  createTask(input: CreateTaskRequest): Promise<TaskResponse> {
    return this.request("/tasks", { method: "POST", body: input });
  }

  listTasks(contactId: string, options: TaskListOptions = {}): Promise<PaginatedResponse<TaskListResponse>> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.owner) search.set("owner", options.owner);
    if (options.group) search.set("group", options.group);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/tasks/${encodeURIComponent(contactId)}${query ? `?${query}` : ""}`);
  }

  listRoomTasks(roomId: string, options: TaskListOptions = {}): Promise<PaginatedResponse<TaskListResponse>> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.owner) search.set("owner", options.owner);
    if (options.group) search.set("group", options.group);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/tasks/room/${encodeURIComponent(roomId)}${query ? `?${query}` : ""}`);
  }

  listWorkspaceTasks(workspaceId: string, options: TaskListOptions = {}): Promise<PaginatedResponse<TaskListResponse>> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.owner) search.set("owner", options.owner);
    if (options.group) search.set("group", options.group);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/tasks/workspace/${encodeURIComponent(workspaceId)}${query ? `?${query}` : ""}`);
  }

  ganttData(workspaceId: string): Promise<GanttResponse> {
    return this.request(`/tasks/gantt/workspace/${encodeURIComponent(workspaceId)}`);
  }

  deleteTask(scopeId: string, taskId: string): Promise<{ ok: true; deleted_id: string }> {
    return this.request(`/tasks/${encodeURIComponent(scopeId)}/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
  }

  updateTask(scopeId: string, taskId: string, input: UpdateTaskRequest): Promise<TaskResponse> {
    return this.request(`/tasks/${encodeURIComponent(scopeId)}/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: input,
    });
  }

  createRoom(input: CreateRoomRequest): Promise<RoomResponse> {
    return this.request("/rooms", { method: "POST", body: input });
  }

  joinRoom(input: JoinRoomRequest): Promise<JoinRoomResponse> {
    return this.request("/rooms/join", { method: "POST", body: input });
  }

  listRooms(): Promise<RoomListResponse> {
    return this.request("/rooms");
  }

  roomMembers(roomId: string): Promise<RoomMembersResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/members`);
  }

  leaveRoom(roomId: string): Promise<{ ok: boolean; room_id: string }> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/leave`, { method: "POST" });
  }

  billingStatus(): Promise<BillingStatus> {
    return this.request("/billing/status");
  }

  billingCheckout(options: { success_url?: string; cancel_url?: string } = {}): Promise<CheckoutResponse> {
    return this.request("/billing/checkout", { method: "POST", body: options });
  }

  billingPortal(): Promise<PortalResponse> {
    return this.request("/billing/portal", { method: "POST" });
  }

  createDocument(contactId: string, input: CreateDocumentRequest): Promise<DocumentResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}`, { method: "POST", body: input });
  }

  listDocuments(contactId: string, options: { limit?: number; cursor?: string } = {}): Promise<PaginatedResponse<DocumentListResponse>> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/documents/${encodeURIComponent(contactId)}${query ? `?${query}` : ""}`);
  }

  getDocument(contactId: string, docId: string): Promise<DocumentResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}/${encodeURIComponent(docId)}`);
  }

  updateDocument(contactId: string, docId: string, input: UpdateDocumentRequest): Promise<DocumentResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}/${encodeURIComponent(docId)}`, { method: "PUT", body: input });
  }

  documentVersions(contactId: string, docId: string): Promise<DocumentVersionsResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}/${encodeURIComponent(docId)}/versions`);
  }

  documentVersion(contactId: string, docId: string, version: number): Promise<DocumentVersionResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}/${encodeURIComponent(docId)}/versions/${version}`);
  }

  deleteDocument(contactId: string, docId: string): Promise<AckResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}/${encodeURIComponent(docId)}`, { method: "DELETE" });
  }

  auditLog(options: AuditLogOptions = {}): Promise<PaginatedResponse<AuditLogResponse>> {
    const search = new URLSearchParams();
    if (options.action) search.set("action", options.action);
    if (options.target_type) search.set("target_type", options.target_type);
    if (options.target_id) search.set("target_id", options.target_id);
    if (options.after) search.set("after", options.after);
    if (options.before) search.set("before", options.before);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/audit-events${query ? `?${query}` : ""}`);
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string; ifMatch?: string } = {}
  ): Promise<T> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const method = options.method ?? "GET";
    if (requiresIdempotencyKey(path, method)) {
      headers.set("Idempotency-Key", options.idempotencyKey ?? crypto.randomUUID());
    }
    if (options.ifMatch) headers.set("If-Match", options.ifMatch);
    if (options.auth !== false) {
      if (!this.secret) {
        throw new Error("TrunkClient requires a secret for authenticated requests");
      }
      headers.set("Authorization", `Bearer ${this.secret}`);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const body = await readJson(response);
    if (!response.ok) {
      const retryAfter = response.headers.get("Retry-After");
      throw new TrunkApiError(
        response.status,
        body,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }
    return body as T;
  }
}

function requiresIdempotencyKey(path: string, method: string): boolean {
  return method === "POST" && (path === "/messages" || /^\/messages\/[^/]+\/reply$/.test(path) || /^\/messages\/[^/]+\/forward$/.test(path));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function signWebhookPayload(secret: string, body: string): Promise<string> {
  return signTrunkWebhook(body, secret);
}

export async function verifyWebhookSignature(secret: string, body: string, signature: string): Promise<boolean> {
  return verifyTrunkWebhook(signature, body, secret);
}

export { signTrunkWebhook, verifyTrunkWebhook };
