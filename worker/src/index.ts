import { handleMcpRequest } from "./mcp";

export interface Env {
  AGENT_CONNECTION: DurableObjectNamespace;
  PUSH_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint — streamable HTTP for agent tool access
    if (url.pathname === "/mcp") {
      return handleMcpRequest(request);
    }

    // POST /notify/:agentId — called by the Vercel API when a message arrives
    if (request.method === "POST" && url.pathname.startsWith("/notify/")) {
      const agentId = url.pathname.split("/notify/")[1];
      if (!agentId) return new Response("Missing agent ID", { status: 400 });

      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.PUSH_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = await request.json() as Record<string, unknown>;
      const id = env.AGENT_CONNECTION.idFromName(agentId);
      const stub = env.AGENT_CONNECTION.get(id);

      return stub.fetch(new Request("http://internal/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    // GET /connect/:agentId — WebSocket upgrade for agents
    if (request.method === "GET" && url.pathname.startsWith("/connect/")) {
      const agentId = url.pathname.split("/connect/")[1];
      if (!agentId) return new Response("Missing agent ID", { status: 400 });

      const secret = url.searchParams.get("secret");
      if (!secret) return new Response("Missing secret query param", { status: 401 });

      const id = env.AGENT_CONNECTION.idFromName(agentId);
      const stub = env.AGENT_CONNECTION.get(id);

      return stub.fetch(new Request(`http://internal/connect?secret=${secret}`, {
        headers: request.headers,
      }));
    }

    // Health
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ name: "trunk-push", version: "0.2.0", status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// --- Durable Object: AgentConnection ---

export class AgentConnection {
  private connections: Set<WebSocket> = new Set();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.state.getWebSockets().forEach((ws) => this.connections.add(ws));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);
      this.connections.add(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      const message = await request.json();
      const payload = JSON.stringify(message);

      const sockets = this.state.getWebSockets();
      let delivered = 0;
      for (const ws of sockets) {
        try {
          ws.send(payload);
          delivered++;
        } catch {
          // Dead connection
        }
      }

      return new Response(JSON.stringify({ delivered, total_connections: sockets.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") {
      ws.send("pong");
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.connections.delete(ws);
  }

  webSocketError(ws: WebSocket, error: unknown) {
    this.connections.delete(ws);
  }
}
