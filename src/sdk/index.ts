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

export type AnalyticsResponse = {
  period_days: number;
  total_sent: number;
  total_received: number;
  volume_by_day: Record<string, { sent: number; received: number }>;
  top_contacts: Array<{ agent_id: string; sent: number; received: number; total: number }>;
  by_type: Record<string, number>;
  avg_response_ms: number | null;
  response_count: number;
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

export type WebhookRetryResponse = {
  ok: boolean;
  delivery_id: string;
  original_delivery_id: string;
  message_id: string;
  status?: number;
  latency_ms: number;
  error: string | null;
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

export type WorkspaceMember = {
  agent_id: string;
  name: string;
  owner?: string | null;
  role: string;
};

export type WorkspaceInfo = {
  workspace: WorkspaceResponse;
  members: WorkspaceMember[];
};

export type WorkspaceMembersResponse = {
  members: WorkspaceMember[];
};

export type PresenceMember = {
  agent_id: string;
  name: string;
  owner?: string | null;
  role?: string;
  status_text?: string | null;
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
  expires_at?: string;
  ttl_seconds?: number;
  attachment_ids?: string[];
};

export type MessageReceipt = {
  id: string;
  thread_id: string;
  status: string;
  created_at: string | Date;
  recipients?: number;
  scheduled_at?: string;
  expires_at?: string | Date;
};

export type TrunkMessage = {
  id: string;
  from_agent: string;
  to_agent: string;
  to_workspace?: string | null;
  to_room?: string | null;
  thread_id: string | null;
  reply_to?: string | null;
  idempotency_key?: string | null;
  type: string;
  payload: TrunkPayload;
  status: string;
  created_at: string | Date;
  read_at?: string | Date | null;
  delivered_at?: string | Date | null;
  processed_at?: string | Date | null;
  replied_at?: string | Date | null;
  deleted_at?: string | Date | null;
  edited_at?: string | Date | null;
  pinned_at?: string | Date | null;
  pinned_by?: string | null;
  scheduled_at?: string | Date | null;
  expires_at?: string | Date | null;
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

export type VerificationStatus = "pending" | "passed" | "failed" | "skipped";

export type FileClaim = {
  path: string;
  claimed_by: string | null;
  claimed_at: string | null;
  expires_at: string | null;
  task_id?: string | null;
  note?: string | null;
};

export type VerificationState = {
  command: string;
  status: VerificationStatus;
  output?: string | null;
  verified_by?: string | null;
  verified_at?: string | null;
};

export type BlockerState = {
  reason: string;
  waiting_on?: string | null;
  blocked_by?: string | null;
  blocked_at?: string | null;
};

export type CheckpointState = {
  summary: string;
  status?: string;
  files_changed: string[];
  commands_run: string[];
  verification?: VerificationState | null;
  blocker?: BlockerState | null;
  next_step?: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

export type HandoffState = {
  from_agent: string | null;
  to_agent: string | null;
  summary: string;
  next_action?: string | null;
  acknowledged_at?: string | null;
  created_at: string | null;
};

export type CoordinationActivity = {
  type: "claim" | "checkpoint" | "handoff" | "release" | "blocker";
  agent_id: string | null;
  at: string | null;
  summary?: string | null;
  files?: string[];
  verification?: VerificationState | null;
  blocker?: BlockerState | null;
  handoff_to?: string | null;
};

export type TaskCoordinationState = {
  claimed_files: FileClaim[];
  checkpoint: CheckpointState | null;
  verification: VerificationState | null;
  blocker: BlockerState | null;
  handoff: HandoffState | null;
  activity: CoordinationActivity[];
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
  metadata: Record<string, unknown>;
  coordination: TaskCoordinationState;
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

export type ClaimTaskRequest = {
  claimed_files?: string[];
  ttl_seconds?: number;
  reason?: string;
  force?: boolean;
  expected_status?: "open" | "in-progress" | "done" | "blocked";
  announce?: boolean;
  announcement?: string | null;
};

export type CheckpointTaskRequest = {
  summary: string;
  status?: "open" | "in-progress" | "done" | "blocked";
  files_changed?: string[];
  commands_run?: string[];
  verification?: {
    command: string;
    status: VerificationStatus;
    output?: string | null;
  } | null;
  blocker?: {
    reason: string;
    waiting_on?: string | null;
  } | null;
  next_step?: string | null;
  announce?: boolean;
  announcement?: string | null;
};

export type HandoffTaskRequest = {
  to_agent?: string | null;
  summary: string;
  next_action?: string | null;
  status?: "open" | "in-progress" | "done" | "blocked";
  announce?: boolean;
  announcement?: string | null;
};

export type RoomStateResponse = {
  room: {
    id: string;
    name: string;
    created_by: string;
    created_at: string | Date;
    metadata: Record<string, unknown>;
  };
  members: Array<{
    agent_id: string;
    name: string;
    owner?: string | null;
    role: string;
    joined_at: string | Date;
    last_seen_at: string | Date | null;
    status_text: string | null;
    active: boolean;
  }>;
  tasks: TaskResponse[];
  file_claims: Array<FileClaim & { task_id: string; task_title: string; stale: boolean }>;
  blockers: Array<BlockerState & { task_id: string; task_title: string }>;
  checkpoints: Array<CheckpointState & { task_id: string; task_title: string }>;
  handoffs: Array<HandoffState & { task_id: string; task_title: string }>;
  latest_activity: {
    messages: TrunkMessage[];
    task_activity: Array<CoordinationActivity & { task_id: string; task_title: string }>;
  };
  summary: {
    members: number;
    active_members: number;
    open_tasks: number;
    in_progress_tasks: number;
    blocked_tasks: number;
    done_tasks: number;
    file_claims: number;
    stale_claims: number;
    blockers: number;
    handoffs: number;
  };
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

export type RoomHeartbeatRunResponse = {
  checked: number;
  sent: number;
  skipped: Array<{ room_id: string; reason: string }>;
  heartbeats: Array<{
    room_id: string;
    thread_id: string | null;
    recipients: number;
    message_ids: string[];
  }>;
};

export type UpdateRoomRequest = {
  name?: string;
  metadata?: Record<string, unknown>;
};

export type UpdateRoomResponse = {
  id: string;
  name: string;
  pairing_code: string;
  metadata?: Record<string, unknown>;
  created_at?: string | Date;
};

export type KickMemberRequest = {
  agent_id: string;
};

export type KickMemberResponse = {
  ok: boolean;
  kicked: string;
  room_id: string;
};

export type ChangeRoleRequest = {
  role: "admin" | "member";
};

export type ChangeRoleResponse = {
  ok: boolean;
  agent_id: string;
  role: string;
  room_id: string;
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
  has_more?: boolean;
  next_cursor?: string | null;
  total?: number;
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

export type ThreadListItem = {
  thread_id: string;
  message_count: number;
  unread_count: number;
  participants: Array<{ agent_id: string; name: string | null }>;
  last_message: {
    id: string;
    from: string;
    from_name: string | null;
    type: string;
    preview: string | null;
    created_at: string | Date;
  };
  last_activity: string | Date;
};

export type ThreadListOptions = {
  limit?: number;
  cursor?: string;
};

export type ThreadListResponse = {
  threads: ThreadListItem[];
};

export type AuditEvent = {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string | Date;
};

export type MessageLabel = {
  id: string;
  label: string;
  created_at: string | Date;
};

export type MessageLabelsResponse = {
  message_id: string;
  labels: MessageLabel[];
  count: number;
};

export type LabelSummary = {
  label: string;
  count: number;
};

export type LabelListResponse = {
  labels: LabelSummary[];
};

export type ContactNote = {
  id?: string;
  contact_id: string;
  content: string | null;
  created_at?: string | Date;
  updated_at?: string | Date;
};

export type BlockedContact = {
  agent_id: string;
  name: string | null;
  reason: string | null;
  blocked_at: string | Date;
};

export type BlockedListResponse = {
  blocked: BlockedContact[];
  count: number;
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

export type SavedSearchResponse = {
  id: string;
  name: string;
  query: Record<string, string>;
  created_at: string;
};

export type NotificationPrefsResponse = {
  muted: boolean;
  urgency_filter: string;
  updated_at?: string;
};

export type TemplateResponse = {
  id: string;
  name: string;
  type: string;
  payload: Record<string, unknown>;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageEditEntry = {
  version: number;
  previous_payload: Record<string, unknown>;
  edited_by: string;
  created_at: string | Date;
};

export type MessageEditHistoryResponse = {
  message_id: string;
  current_payload: Record<string, unknown>;
  edited_at: string | Date | null;
  edits: MessageEditEntry[];
  edit_count: number;
};

export type AttachmentUploadRequest = {
  filename: string;
  content_type?: string;
  data: string; // base64
  message_id?: string;
};

export type AttachmentResponse = {
  id: string;
  message_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

export type AttachmentDownloadResponse = AttachmentResponse & {
  data: string; // base64
};

export type AttachmentListResponse = {
  attachments: AttachmentResponse[];
  next_cursor: string | null;
  has_more: boolean;
};

export type MessageAttachmentsResponse = {
  message_id: string;
  attachments: AttachmentResponse[];
};

export type CreateRoomWebhookRequest = {
  url: string;
  secret?: string;
  filter_group?: string;
  filter_priority?: string;
  filter_status?: string;
};

export type RoomWebhookResponse = {
  id: string;
  room_id: string;
  url: string;
  filter_group: string | null;
  filter_priority: string | null;
  filter_status: string | null;
  active: boolean;
  created_by: string;
  created_at: string | Date;
};

export type RoomWebhookListResponse = {
  webhooks: RoomWebhookResponse[];
};

export type HealthResponse = {
  status: "ok";
  version: string;
  uptime: number;
};

export type ReadyResponse = {
  status: "ready" | "unavailable";
  database: "connected" | "disconnected";
  code?: string;
};

export type TrunkClientOptions = {
  baseUrl: string;
  secret?: string;
  fetch?: typeof fetch;
};

export class TrunkApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | undefined;
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
    this.code =
      typeof body === "object" && body !== null && "code" in body
        ? String((body as { code: unknown }).code)
        : undefined;
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

  health(): Promise<HealthResponse> {
    return this.request("/health", { auth: false });
  }

  ready(): Promise<ReadyResponse> {
    return this.request("/ready", { auth: false });
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

  analytics(options: { days?: number } = {}): Promise<AnalyticsResponse> {
    const search = new URLSearchParams();
    if (options.days !== undefined) search.set("days", String(options.days));
    const query = search.toString();
    return this.request(`/agents/me/analytics${query ? `?${query}` : ""}`);
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

  retryWebhookDelivery(deliveryId: string): Promise<WebhookRetryResponse> {
    return this.request(`/agents/me/webhook/deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: "POST" });
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

  updateWorkspace(input: { name?: string; metadata?: Record<string, unknown> }): Promise<WorkspaceResponse & { metadata?: Record<string, unknown> }> {
    return this.request("/workspaces/me", { method: "PATCH", body: input });
  }

  workspaceMembers(workspaceId: string): Promise<WorkspaceMembersResponse> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/members`);
  }

  kickWorkspaceMember(agentId: string): Promise<{ ok: boolean; kicked: string }> {
    return this.request("/workspaces/kick", { method: "POST", body: { agent_id: agentId } });
  }

  changeWorkspaceMemberRole(agentId: string, role: "admin" | "member"): Promise<{ ok: boolean; agent_id: string; role: string }> {
    return this.request(`/workspaces/members/${encodeURIComponent(agentId)}/role`, { method: "PATCH", body: { role } });
  }

  deleteWorkspace(): Promise<{ ok: boolean; deleted: string }> {
    return this.request("/workspaces", { method: "DELETE" });
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

  deliverScheduled(): Promise<{ delivered: number; blocked?: number; checked_at: string }> {
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

  thread(threadId: string, options: { limit?: number; cursor?: string } = {}): Promise<MessagesResponse> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}${qs ? `?${qs}` : ""}`);
  }

  threadSummary(threadId: string): Promise<ThreadSummaryResponse> {
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}/summary`);
  }

  markRead(messageId: string): Promise<{ ok: true; read_at?: string; already_read?: boolean }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/read`, { method: "POST" });
  }

  ack(messageId: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST" });
  }

  ackBulk(messageIds: string[]): Promise<{ ok: true; acked: number }> {
    return this.request("/messages/ack-bulk", { method: "POST", body: { message_ids: messageIds } });
  }

  readBulk(messageIds: string[]): Promise<{ ok: true; marked: number }> {
    return this.request("/messages/read-bulk", { method: "POST", body: { message_ids: messageIds } });
  }

  deleteBulk(messageIds: string[]): Promise<{ ok: true; deleted: number }> {
    return this.request("/messages/delete-bulk", { method: "POST", body: { message_ids: messageIds } });
  }

  labelBulk(messageIds: string[], label: string): Promise<{ ok: true; labeled: number }> {
    return this.request("/messages/label-bulk", { method: "POST", body: { message_ids: messageIds, label } });
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

  // Room-scoped fact methods
  listRoomFacts(roomId: string): Promise<{ facts: Array<{ key: string; value: unknown; version: number; updated_by: string; updated_at: string }> }> {
    return this.request(`/context/room/${encodeURIComponent(roomId)}/facts`);
  }

  getRoomFact(roomId: string, key: string): Promise<{ key: string; value: unknown; version: number; updated_by: string; updated_at?: string | Date }> {
    return this.request(`/context/room/${encodeURIComponent(roomId)}/facts/${encodeURIComponent(key)}`);
  }

  putRoomFact(roomId: string, key: string, value: unknown, options: { ifMatch?: string | number } = {}): Promise<{ key: string; value: unknown; version: number; updated_by: string }> {
    return this.request(`/context/room/${encodeURIComponent(roomId)}/facts/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
      ifMatch: options.ifMatch === undefined ? undefined : String(options.ifMatch),
    });
  }

  deleteRoomFact(roomId: string, key: string): Promise<AckResponse> {
    return this.request(`/context/room/${encodeURIComponent(roomId)}/facts/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  // Workspace-scoped fact methods
  listWorkspaceFacts(workspaceId: string): Promise<{ facts: Array<{ key: string; value: unknown; version: number; updated_by: string; updated_at: string }> }> {
    return this.request(`/context/workspace/${encodeURIComponent(workspaceId)}/facts`);
  }

  getWorkspaceFact(workspaceId: string, key: string): Promise<{ key: string; value: unknown; version: number; updated_by: string; updated_at?: string | Date }> {
    return this.request(`/context/workspace/${encodeURIComponent(workspaceId)}/facts/${encodeURIComponent(key)}`);
  }

  putWorkspaceFact(workspaceId: string, key: string, value: unknown, options: { ifMatch?: string | number } = {}): Promise<{ key: string; value: unknown; version: number; updated_by: string }> {
    return this.request(`/context/workspace/${encodeURIComponent(workspaceId)}/facts/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
      ifMatch: options.ifMatch === undefined ? undefined : String(options.ifMatch),
    });
  }

  deleteWorkspaceFact(workspaceId: string, key: string): Promise<AckResponse> {
    return this.request(`/context/workspace/${encodeURIComponent(workspaceId)}/facts/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  editMessage(messageId: string, payload: Record<string, unknown>): Promise<{ id: string; thread_id: string; payload: Record<string, unknown>; edited_at: string; status: string; version: number }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: { payload } });
  }

  messageEditHistory(messageId: string): Promise<MessageEditHistoryResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/edits`);
  }

  deleteMessage(messageId: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  }

  purgeExpiredMessages(days = 90): Promise<{ purged: number; cutoff: string }> {
    return this.request("/messages/purge-expired", { method: "POST", body: { days } });
  }

  forward(messageId: string, to: string, comment?: string): Promise<MessageReceipt> {
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

  claimTask(scopeId: string, taskId: string, input: ClaimTaskRequest = {}): Promise<TaskResponse> {
    return this.request(`/tasks/${encodeURIComponent(scopeId)}/${encodeURIComponent(taskId)}/claim`, {
      method: "POST",
      body: input,
    });
  }

  checkpointTask(scopeId: string, taskId: string, input: CheckpointTaskRequest): Promise<TaskResponse> {
    return this.request(`/tasks/${encodeURIComponent(scopeId)}/${encodeURIComponent(taskId)}/checkpoint`, {
      method: "POST",
      body: input,
    });
  }

  handoffTask(scopeId: string, taskId: string, input: HandoffTaskRequest): Promise<TaskResponse> {
    return this.request(`/tasks/${encodeURIComponent(scopeId)}/${encodeURIComponent(taskId)}/handoff`, {
      method: "POST",
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

  roomState(roomId: string): Promise<RoomStateResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/state`);
  }

  runRoomHeartbeats(): Promise<RoomHeartbeatRunResponse> {
    return this.request("/rooms/heartbeats/run", { method: "POST" });
  }

  leaveRoom(roomId: string): Promise<{ ok: boolean; room_id: string }> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/leave`, { method: "POST" });
  }

  updateRoom(roomId: string, input: UpdateRoomRequest): Promise<UpdateRoomResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}`, { method: "PATCH", body: input });
  }

  kickRoomMember(roomId: string, input: KickMemberRequest): Promise<KickMemberResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/kick`, { method: "POST", body: input });
  }

  changeRoomMemberRole(roomId: string, agentId: string, input: ChangeRoleRequest): Promise<ChangeRoleResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(agentId)}/role`, { method: "PUT", body: input });
  }

  deleteRoom(roomId: string): Promise<{ ok: boolean; deleted: string }> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
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

  // Room-scoped document methods
  createRoomDocument(roomId: string, input: CreateDocumentRequest): Promise<DocumentResponse> {
    return this.request(`/documents/room/${encodeURIComponent(roomId)}`, { method: "POST", body: input });
  }

  listRoomDocuments(roomId: string, options: { limit?: number; cursor?: string } = {}): Promise<PaginatedResponse<DocumentListResponse>> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/documents/room/${encodeURIComponent(roomId)}${query ? `?${query}` : ""}`);
  }

  getRoomDocument(roomId: string, docId: string): Promise<DocumentResponse> {
    return this.request(`/documents/room/${encodeURIComponent(roomId)}/${encodeURIComponent(docId)}`);
  }

  updateRoomDocument(roomId: string, docId: string, input: UpdateDocumentRequest): Promise<DocumentResponse> {
    return this.request(`/documents/room/${encodeURIComponent(roomId)}/${encodeURIComponent(docId)}`, { method: "PUT", body: input });
  }

  roomDocumentVersions(roomId: string, docId: string): Promise<DocumentVersionsResponse> {
    return this.request(`/documents/room/${encodeURIComponent(roomId)}/${encodeURIComponent(docId)}/versions`);
  }

  roomDocumentVersion(roomId: string, docId: string, version: number): Promise<DocumentVersionResponse> {
    return this.request(`/documents/room/${encodeURIComponent(roomId)}/${encodeURIComponent(docId)}/versions/${version}`);
  }

  deleteRoomDocument(roomId: string, docId: string): Promise<AckResponse> {
    return this.request(`/documents/room/${encodeURIComponent(roomId)}/${encodeURIComponent(docId)}`, { method: "DELETE" });
  }

  // Workspace-scoped document methods
  createWorkspaceDocument(workspaceId: string, input: CreateDocumentRequest): Promise<DocumentResponse> {
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}`, { method: "POST", body: input });
  }

  listWorkspaceDocuments(workspaceId: string, options: { limit?: number; cursor?: string } = {}): Promise<PaginatedResponse<DocumentListResponse>> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}${query ? `?${query}` : ""}`);
  }

  getWorkspaceDocument(workspaceId: string, docId: string): Promise<DocumentResponse> {
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(docId)}`);
  }

  updateWorkspaceDocument(workspaceId: string, docId: string, input: UpdateDocumentRequest): Promise<DocumentResponse> {
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(docId)}`, { method: "PUT", body: input });
  }

  workspaceDocumentVersions(workspaceId: string, docId: string): Promise<DocumentVersionsResponse> {
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(docId)}/versions`);
  }

  workspaceDocumentVersion(workspaceId: string, docId: string, version: number): Promise<DocumentVersionResponse> {
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(docId)}/versions/${version}`);
  }

  deleteWorkspaceDocument(workspaceId: string, docId: string): Promise<AckResponse> {
    return this.request(`/documents/workspace/${encodeURIComponent(workspaceId)}/${encodeURIComponent(docId)}`, { method: "DELETE" });
  }

  listThreads(options: ThreadListOptions = {}): Promise<PaginatedResponse<ThreadListResponse>> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/messages/threads${query ? `?${query}` : ""}`);
  }

  setStatus(text: string | null): Promise<{ ok: true; status_text: string | null }> {
    return this.request("/agents/me/status", { method: "PUT", body: { text } });
  }

  contactNote(agentId: string): Promise<ContactNote> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/notes`);
  }

  setContactNote(agentId: string, content: string): Promise<ContactNote> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/notes`, { method: "PUT", body: { content } });
  }

  deleteContactNote(agentId: string): Promise<AckResponse> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/notes`, { method: "DELETE" });
  }

  blockContact(agentId: string, reason?: string): Promise<{ ok: true; id?: string; blocked_at?: string; already_blocked?: boolean }> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/block`, { method: "POST", body: { reason } });
  }

  unblockContact(agentId: string): Promise<AckResponse> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/block`, { method: "DELETE" });
  }

  blockedContacts(): Promise<BlockedListResponse> {
    return this.request("/contacts/blocked");
  }

  notificationPrefs(agentId: string): Promise<NotificationPrefsResponse> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/notifications`);
  }

  setNotificationPrefs(agentId: string, prefs: { muted?: boolean; urgency_filter?: string }): Promise<NotificationPrefsResponse> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/notifications`, { method: "PUT", body: prefs });
  }

  addContactTag(agentId: string, tag: string): Promise<{ id?: string; tag?: string; created_at?: string; ok?: true; already_tagged?: boolean }> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/tags`, { method: "POST", body: { tag } });
  }

  removeContactTag(agentId: string, tag: string): Promise<{ ok: true }> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" });
  }

  contactTags(agentId: string): Promise<{ tags: string[] }> {
    return this.request(`/contacts/${encodeURIComponent(agentId)}/tags`);
  }

  contactsByTag(tag: string, opts?: { limit?: number; cursor?: string }): Promise<{ contacts: Array<{ agent_id: string; name: string | null; tagged_at: string }>; next_cursor: string | null; has_more: boolean }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.request(`/contacts/by-tag/${encodeURIComponent(tag)}${qs ? `?${qs}` : ""}`);
  }

  allContactTags(): Promise<{ tags: Array<{ tag: string; count: number }> }> {
    return this.request("/contacts/tags/all");
  }

  addLabel(messageId: string, label: string): Promise<{ id: string; message_id: string; label: string; created_at: string }> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/labels`, { method: "POST", body: { label } });
  }

  removeLabel(messageId: string, label: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
  }

  messageLabels(messageId: string): Promise<MessageLabelsResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/labels`);
  }

  messagesByLabel(label: string, options: { limit?: number; cursor?: string } = {}): Promise<PaginatedResponse<MessagesResponse>> {
    const search = new URLSearchParams();
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    if (options.cursor) search.set("cursor", options.cursor);
    const query = search.toString();
    return this.request(`/messages/by-label/${encodeURIComponent(label)}${query ? `?${query}` : ""}`);
  }

  allLabels(): Promise<LabelListResponse> {
    return this.request("/messages/labels/all");
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

  // --- Saved searches ---

  listSavedSearches(): Promise<{ searches: SavedSearchResponse[] }> {
    return this.request("/messages/searches");
  }

  saveSearch(name: string, query: Record<string, string>): Promise<SavedSearchResponse> {
    return this.request("/messages/searches", { method: "POST", body: { name, query } });
  }

  deleteSavedSearch(searchId: string): Promise<{ ok: true }> {
    return this.request(`/messages/searches/${encodeURIComponent(searchId)}`, { method: "DELETE" });
  }

  // --- Templates ---

  listTemplates(opts?: { limit?: number; cursor?: string }): Promise<{ templates: TemplateResponse[]; next_cursor: string | null; has_more: boolean }> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.request(`/templates${qs ? `?${qs}` : ""}`);
  }

  createTemplate(input: { name: string; type: string; payload: Record<string, unknown>; description?: string }): Promise<TemplateResponse> {
    return this.request("/templates", { method: "POST", body: input });
  }

  getTemplate(templateId: string): Promise<TemplateResponse> {
    return this.request(`/templates/${encodeURIComponent(templateId)}`);
  }

  updateTemplate(templateId: string, input: { name?: string; type?: string; payload?: Record<string, unknown>; description?: string }): Promise<TemplateResponse> {
    return this.request(`/templates/${encodeURIComponent(templateId)}`, { method: "PATCH", body: input });
  }

  deleteTemplate(templateId: string): Promise<{ ok: true }> {
    return this.request(`/templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  }

  // --- Attachments ---

  uploadAttachment(input: AttachmentUploadRequest): Promise<AttachmentResponse> {
    return this.request("/attachments", { method: "POST", body: input });
  }

  getAttachment(attachmentId: string): Promise<AttachmentDownloadResponse> {
    return this.request(`/attachments/${encodeURIComponent(attachmentId)}`);
  }

  listAttachments(opts?: { limit?: number; cursor?: string }): Promise<AttachmentListResponse> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.request(`/attachments${qs ? `?${qs}` : ""}`);
  }

  messageAttachments(messageId: string): Promise<MessageAttachmentsResponse> {
    return this.request(`/attachments/message/${encodeURIComponent(messageId)}`);
  }

  deleteAttachment(attachmentId: string): Promise<{ ok: true }> {
    return this.request(`/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
  }

  // --- Room Webhooks ---

  createRoomWebhook(roomId: string, input: CreateRoomWebhookRequest): Promise<RoomWebhookResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/webhooks`, { method: "POST", body: input });
  }

  listRoomWebhooks(roomId: string): Promise<RoomWebhookListResponse> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/webhooks`);
  }

  deleteRoomWebhook(roomId: string, webhookId: string): Promise<{ ok: true; deleted_id: string }> {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
  }

  raw<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string; ifMatch?: string } = {},
  ): Promise<T> {
    return this.request<T>(path, options);
  }

  // --- Agent Cards ---

  getMyAgentCard(): Promise<{ card: unknown; signed: boolean }> {
    return this.request("/agents/me/card");
  }

  upsertMyAgentCard(input: {
    description?: string;
    protocol?: string[];
    version?: string;
    homepage_url?: string;
    documentation_url?: string;
    repository_url?: string;
    capabilities?: Array<{ id: string; description?: string; inputs?: Record<string, unknown> }>;
    message_types?: string[];
    endpoints?: Array<{ type: string; url: string; description?: string; auth?: string }>;
    contact_policy?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<{ card: unknown; signed: boolean }> {
    return this.request("/agents/me/card", { method: "PUT", body: input });
  }

  getAgentCard(agentId: string): Promise<{ card: unknown; signed: boolean }> {
    return this.request(`/agents/${encodeURIComponent(agentId)}/card`);
  }

  // --- Scoped grants ---

  listGrants(): Promise<{ grants: unknown[]; count: number }> {
    return this.request("/grants");
  }

  createGrant(input: {
    name: string;
    description?: string;
    scopes: string[];
    expires_at?: string;
    not_before?: string;
    audience_agent_id?: string;
    audience_workspace_id?: string;
    room_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ grant: unknown; secret: string; warning?: string }> {
    return this.request("/grants", { method: "POST", body: input });
  }

  revokeGrant(grantId: string, reason?: string): Promise<{ ok: true; grant: unknown }> {
    return this.request(`/grants/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
      body: reason ? { reason } : {},
    });
  }

  // --- Fact history (provenance) ---

  factHistory(
    contactId: string,
    key: string,
  ): Promise<{ scope: string; key: string; current: unknown; history: unknown[]; count: number }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}/history`);
  }

  roomFactHistory(
    roomId: string,
    key: string,
  ): Promise<{ scope: string; key: string; current: unknown; history: unknown[]; count: number }> {
    return this.request(`/context/room/${encodeURIComponent(roomId)}/facts/${encodeURIComponent(key)}/history`);
  }

  workspaceFactHistory(
    workspaceId: string,
    key: string,
  ): Promise<{ scope: string; key: string; current: unknown; history: unknown[]; count: number }> {
    return this.request(
      `/context/workspace/${encodeURIComponent(workspaceId)}/facts/${encodeURIComponent(key)}/history`,
    );
  }

  putFactWithProvenance(
    contactId: string,
    key: string,
    value: unknown,
    provenance: { reason?: string; source_message_id?: string; source_thread_id?: string; ifMatch?: string | number } = {},
  ): Promise<{ key: string; value: unknown; version: number; updated_by: string; set_by?: string; reason?: string | null }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value, reason: provenance.reason, source_message_id: provenance.source_message_id, source_thread_id: provenance.source_thread_id },
      ifMatch: provenance.ifMatch === undefined ? undefined : String(provenance.ifMatch),
    });
  }

  // --- Inspector ---

  inspectorHealth(options: { days?: number } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (options.days !== undefined) params.set("days", String(options.days));
    const qs = params.toString();
    return this.request(`/inspector/health${qs ? `?${qs}` : ""}`);
  }

  inspectorThread(threadId: string): Promise<unknown> {
    return this.request(`/inspector/thread/${encodeURIComponent(threadId)}`);
  }

  inspectorSummary(): Promise<unknown> {
    return this.request("/inspector");
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
