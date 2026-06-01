import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import agentsRoutes from "./routes/agents.js";
import contactsRoutes from "./routes/contacts.js";
import messagesRoutes from "./routes/messages.js";
import tasksRoutes from "./routes/tasks.js";
import roomsRoutes from "./routes/rooms.js";
import connectRoutes from "./routes/connect.js";
import { handleMcpRequest } from "./mcp/handler.js";

const app = new Hono();

app.use("*", logger());
app.use("*", cors());

// Health check
app.get("/", (c) => c.json({ name: "trunk-relay", version: "0.1.0", status: "ok" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// MCP endpoint (streamable HTTP)
app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

// Routes
app.route("/agents", agentsRoutes);
app.route("/contacts", contactsRoutes);
app.route("/messages", messagesRoutes);
app.route("/tasks", tasksRoutes);
app.route("/rooms", roomsRoutes);
app.route("/connect", connectRoutes);

export default app;
