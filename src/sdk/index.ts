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
  created_at?: string | Date;
};

export type UpdateMeRequest = {
  name?: string;
  owner?: string;
  webhook_url?: string;
};

export type RotateSecretResponse = {
  secret: string;
};

export type PairRequest = {
  code: string;
  alias?: string;
};

export type PairResponse = {
  contact_id: string;
  name: string;
  paired_at: string;
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

export type InboxOptions = {
  status?: string;
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

  pair(input: PairRequest): Promise<PairResponse> {
    return this.request("/contacts/pair", { method: "POST", body: input });
  }

  contacts(): Promise<ContactsResponse> {
    return this.request("/contacts");
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

  thread(threadId: string): Promise<MessagesResponse> {
    return this.request(`/messages/thread/${encodeURIComponent(threadId)}`);
  }

  ack(messageId: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST" });
  }

  reply(messageId: string, input: Omit<SendMessageRequest, "to" | "thread_id">): Promise<MessageReceipt> {
    return this.request(`/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      body: input,
      idempotencyKey: input.idempotency_key,
    });
  }

  getFact(contactId: string, key: string): Promise<{ key: string; value: unknown; updated_by: string; updated_at?: string | Date }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`);
  }

  putFact(contactId: string, key: string, value: unknown): Promise<{ key: string; value: unknown; updated_by: string }> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: { value },
    });
  }

  deleteFact(contactId: string, key: string): Promise<AckResponse> {
    return this.request(`/context/${encodeURIComponent(contactId)}/facts/${encodeURIComponent(key)}`, { method: "DELETE" });
  }

  deleteMessage(messageId: string): Promise<AckResponse> {
    return this.request(`/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  }

  purgeExpiredMessages(days = 90): Promise<{ purged: number; cutoff: string }> {
    return this.request("/messages/purge-expired", { method: "POST", body: { days } });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string } = {}
  ): Promise<T> {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const method = options.method ?? "GET";
    if (requiresIdempotencyKey(path, method)) {
      headers.set("Idempotency-Key", options.idempotencyKey ?? crypto.randomUUID());
    }
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
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${bytesToHex(new Uint8Array(signature))}`;
}

export async function verifyWebhookSignature(secret: string, body: string, signature: string): Promise<boolean> {
  const expected = await signWebhookPayload(secret, body);
  return timingSafeEqual(expected, signature);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < leftBytes.length; i += 1) {
    diff |= leftBytes[i] ^ rightBytes[i];
  }
  return diff === 0;
}
