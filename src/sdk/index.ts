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
};

export type MessageReceipt = {
  id: string;
  thread_id: string;
  status: string;
  created_at: string | Date;
  recipients?: number;
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
};

export type SentOptions = {
  to?: string;
  type?: string;
  limit?: number;
};

export type SearchOptions = {
  q?: string;
  type?: string;
  contact?: string;
  after?: string;
  before?: string;
  limit?: number;
};

export type MessagesResponse = {
  messages: TrunkMessage[];
};

export type AckResponse = {
  ok: true;
};

export type TrunkClientOptions = {
  baseUrl: string;
  secret?: string;
  fetch?: typeof fetch;
};

export class TrunkApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Trunk API request failed with status ${status}`;
    super(message);
    this.name = "TrunkApiError";
    this.status = status;
    this.body = body;
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

  profile(agentId: string): Promise<AgentProfile> {
    return this.request(`/agents/${encodeURIComponent(agentId)}`);
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

  inbox(options: InboxOptions = {}): Promise<MessagesResponse> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    const query = search.toString();
    return this.request(`/messages/inbox${query ? `?${query}` : ""}`);
  }

  inboxStats(): Promise<{ unread: number; total: number; by_type: Record<string, number>; by_status: Record<string, number> }> {
    return this.request("/messages/inbox/stats");
  }

  sent(options: SentOptions = {}): Promise<MessagesResponse> {
    const search = new URLSearchParams();
    if (options.to) search.set("to", options.to);
    if (options.type) search.set("type", options.type);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    const query = search.toString();
    return this.request(`/messages/sent${query ? `?${query}` : ""}`);
  }

  search(options: SearchOptions = {}): Promise<MessagesResponse> {
    const search = new URLSearchParams();
    if (options.q) search.set("q", options.q);
    if (options.type) search.set("type", options.type);
    if (options.contact) search.set("contact", options.contact);
    if (options.after) search.set("after", options.after);
    if (options.before) search.set("before", options.before);
    if (options.limit !== undefined) search.set("limit", String(options.limit));
    const query = search.toString();
    return this.request(`/messages/search${query ? `?${query}` : ""}`);
  }

  thread(threadId: string): Promise<MessagesResponse> {
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}`);
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

  createTask(input: CreateTaskRequest): Promise<TaskResponse> {
    return this.request("/tasks", { method: "POST", body: input });
  }

  listTasks(contactId: string, options: TaskListOptions = {}): Promise<TaskListResponse> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.owner) search.set("owner", options.owner);
    if (options.group) search.set("group", options.group);
    const query = search.toString();
    return this.request(`/tasks/${encodeURIComponent(contactId)}${query ? `?${query}` : ""}`);
  }

  listRoomTasks(roomId: string, options: TaskListOptions = {}): Promise<TaskListResponse> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.owner) search.set("owner", options.owner);
    if (options.group) search.set("group", options.group);
    const query = search.toString();
    return this.request(`/tasks/room/${encodeURIComponent(roomId)}${query ? `?${query}` : ""}`);
  }

  listWorkspaceTasks(workspaceId: string, options: TaskListOptions = {}): Promise<TaskListResponse> {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.owner) search.set("owner", options.owner);
    if (options.group) search.set("group", options.group);
    const query = search.toString();
    return this.request(`/tasks/workspace/${encodeURIComponent(workspaceId)}${query ? `?${query}` : ""}`);
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

  listDocuments(contactId: string): Promise<DocumentListResponse> {
    return this.request(`/documents/${encodeURIComponent(contactId)}`);
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
      throw new TrunkApiError(response.status, body);
    }
    return body as T;
  }
}

function requiresIdempotencyKey(path: string, method: string): boolean {
  return method === "POST" && (path === "/messages" || /^\/messages\/[^/]+\/reply$/.test(path));
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
