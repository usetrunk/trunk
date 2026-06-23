import "dotenv/config";
import { count, eq, sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import {
  agents,
  agentDelegations,
  auditEvents,
  contacts,
  messages,
  roomMembers,
  rooms,
  sharedFacts,
  tasks,
  webhookDeliveries,
} from "../src/db/schema.js";

async function tableCount(name: string, table: any) {
  const [row] = await db.select({ value: count() }).from(table);
  return [name, Number(row.value)] as const;
}

async function statusCount(status: string) {
  const [row] = await db
    .select({ value: count() })
    .from(tasks)
    .where(eq(tasks.status, status));
  return [status, Number(row.value)] as const;
}

async function metadataCount(key: string) {
  const [row] = await db
    .select({ value: count() })
    .from(tasks)
    .where(sql`${tasks.metadata} ? ${key}`);
  return [key, Number(row.value)] as const;
}

async function main() {
  const totals = Object.fromEntries(await Promise.all([
    tableCount("agents", agents),
    tableCount("contacts", contacts),
    tableCount("rooms", rooms),
    tableCount("room_members", roomMembers),
    tableCount("messages", messages),
    tableCount("tasks", tasks),
    tableCount("shared_facts", sharedFacts),
    tableCount("agent_delegations", agentDelegations),
    tableCount("audit_events", auditEvents),
    tableCount("webhook_deliveries", webhookDeliveries),
  ]));

  const tasksByStatus = Object.fromEntries(await Promise.all([
    statusCount("open"),
    statusCount("in-progress"),
    statusCount("blocked"),
    statusCount("done"),
  ]));

  const taskCoordination = Object.fromEntries(await Promise.all([
    metadataCount("claimed_files"),
    metadataCount("checkpoint"),
    metadataCount("verification"),
    metadataCount("blocker"),
    metadataCount("handoff"),
  ]));

  const [roomMessages] = await db
    .select({ value: count() })
    .from(messages)
    .where(sql`${messages.toRoom} IS NOT NULL`);

  const [claimedDelegations] = await db
    .select({ value: count() })
    .from(agentDelegations)
    .where(eq(agentDelegations.status, "claimed"));

  const snapshot = {
    generated_at: new Date().toISOString(),
    totals,
    tasks_by_status: tasksByStatus,
    task_coordination: taskCoordination,
    room_messages: Number(roomMessages.value),
    claimed_delegations: Number(claimedDelegations.value),
  };

  console.log(JSON.stringify(snapshot, null, 2));
}

function findErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const code = findErrorCode(nested);
      if (code) return code;
    }
  }
  return findErrorCode(record.cause);
}

function formatError(error: unknown): string {
  const code = findErrorCode(error);
  if (code === "ECONNREFUSED") {
    return "Could not connect to Postgres. Start the local database or set DATABASE_URL to a reachable relay database.";
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
