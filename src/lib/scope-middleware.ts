import { createMiddleware } from "hono/factory";
import type { AgentVariables } from "./types.js";
import { verifyWorkspaceAccess } from "./workspace.js";
import { verifyRoomAccess } from "./context.js";
import { db } from "../db/index.js";
import { roomMembers } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

/**
 * Middleware that verifies the authenticated agent is a member of the workspace
 * identified by the :workspaceId route parameter. Returns 403 if not.
 */
export function requireWorkspaceMember(paramName = "workspaceId") {
  return createMiddleware<AgentVariables>(async (c, next) => {
    const agentId = c.get("agentId");
    const workspaceId = c.req.param(paramName);
    if (!workspaceId) return c.json({ error: "Missing workspace ID", code: "MISSING_FIELD" }, 400);
    if (!(await verifyWorkspaceAccess(agentId, workspaceId))) {
      return c.json({ error: "Not a workspace member", code: "NOT_MEMBER" }, 403);
    }
    await next();
  });
}

/**
 * Middleware that verifies the authenticated agent is a member of the room
 * identified by the :roomId route parameter. Returns 403 if not.
 */
export function requireRoomMember(paramName = "roomId") {
  return createMiddleware<AgentVariables>(async (c, next) => {
    const agentId = c.get("agentId");
    const roomId = c.req.param(paramName);
    if (!roomId) return c.json({ error: "Missing room ID", code: "MISSING_FIELD" }, 400);
    if (!(await verifyRoomAccess(agentId, roomId))) {
      return c.json({ error: "Not a room member", code: "NOT_MEMBER" }, 403);
    }
    await next();
  });
}

/**
 * Middleware that verifies the authenticated agent is a creator or admin of the room
 * identified by the :roomId route parameter. Sets `roomMembership` on context.
 * Returns 403 if not a member or lacks the required role.
 */
export function requireRoomAdmin(paramName = "roomId") {
  return createMiddleware<AgentVariables>(async (c, next) => {
    const agentId = c.get("agentId");
    const roomId = c.req.param(paramName);
    if (!roomId) return c.json({ error: "Missing room ID", code: "MISSING_FIELD" }, 400);

    const [membership] = await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
      .limit(1);

    if (!membership) return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
    if (membership.role !== "creator" && membership.role !== "admin") {
      return c.json({ error: "Only creators and admins can perform this action", code: "INSUFFICIENT_ROLE" }, 403);
    }
    await next();
  });
}

/**
 * Middleware that verifies the authenticated agent is the creator of the room
 * identified by the :roomId route parameter. Returns 403 if not.
 */
export function requireRoomCreator(paramName = "roomId") {
  return createMiddleware<AgentVariables>(async (c, next) => {
    const agentId = c.get("agentId");
    const roomId = c.req.param(paramName);
    if (!roomId) return c.json({ error: "Missing room ID", code: "MISSING_FIELD" }, 400);

    const [membership] = await db
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.agentId, agentId)))
      .limit(1);

    if (!membership) return c.json({ error: "Not a member of this room", code: "NOT_MEMBER" }, 403);
    if (membership.role !== "creator") {
      return c.json({ error: "Only the creator can perform this action", code: "INSUFFICIENT_ROLE" }, 403);
    }
    await next();
  });
}
