/**
 * Fact history service — provenance tracking for shared facts.
 *
 * Every upsert of a fact is recorded in `fact_history` before the live row is
 * updated. The live `shared_facts` row gets enriched with
 * `set_by` / `reason` / `source_message_id` / `source_thread_id` so
 * inspectors can see at a glance who set a value and why.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { factHistory, sharedFacts } from "../db/schema.js";
import { isValidFactKey, isValidFactValue, checkFactCountLimit } from "./context.js";

export type FactProvenance = {
  set_by?: string | null;
  reason?: string | null;
  source_message_id?: string | null;
  source_thread_id?: string | null;
};

export type FactHistoryInsert = {
  scope: string;
  key: string;
  version: number;
  value: unknown;
  setBy: string;
  reason?: string | null;
  sourceMessageId?: string | null;
  sourceThreadId?: string | null;
  supersededBy?: string | null;
};

/**
 * Lightweight helper used when a code path already wrote the live fact row
 * and just needs to drop a history line for provenance. Heavy path
 * (with the full supersede dance) lives in `recordFactWrite`.
 */
export async function recordFactHistoryEntry(entry: FactHistoryInsert): Promise<void> {
  await db.insert(factHistory).values({
    scope: entry.scope,
    key: entry.key,
    version: entry.version,
    value: entry.value,
    setBy: entry.setBy,
    reason: entry.reason ?? null,
    sourceMessageId: entry.sourceMessageId ?? null,
    sourceThreadId: entry.sourceThreadId ?? null,
    supersededBy: entry.supersededBy ?? null,
  });
}

export class FactHistoryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "FactHistoryError";
    this.status = status;
  }
}

export async function recordFactWrite(
  scope: string,
  key: string,
  value: unknown,
  agentId: string,
  provenance: FactProvenance = {},
): Promise<{ version: number; created: boolean }> {
  if (!isValidFactKey(key)) {
    throw new FactHistoryError("Invalid fact key", 400);
  }
  if (!isValidFactValue(value)) {
    throw new FactHistoryError("Fact value too large", 400);
  }
  if (!(await checkFactCountLimit(scope, key))) {
    throw new FactHistoryError("Too many facts in scope", 400);
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(sharedFacts)
      .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)))
      .limit(1);

    if (existing.length === 0) {
      await tx.insert(sharedFacts).values({
        scope,
        key,
        value,
        updatedBy: agentId,
      });
  const [historyRow] = await tx
    .insert(factHistory)
    .values({
      scope,
      key,
      version: 1,
      value,
      setBy: agentId,
      reason: provenance.reason ?? null,
      sourceMessageId: provenance.source_message_id ?? null,
      sourceThreadId: provenance.source_thread_id ?? null,
    })
    .returning();
  void historyRow;
  return { version: 1, created: true };
    }

    const previous = existing[0];
    const previousVersion = previous.version;
    const nextVersion = previousVersion + 1;

    await tx
      .update(sharedFacts)
      .set({
        value,
        version: nextVersion,
        updatedBy: agentId,
        updatedAt: new Date(),
      })
      .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)));

    await tx.insert(factHistory).values({
      scope,
      key,
      version: nextVersion,
      value,
      setBy: agentId,
      reason: provenance.reason ?? null,
      sourceMessageId: provenance.source_message_id ?? null,
      sourceThreadId: provenance.source_thread_id ?? null,
    });

    // Mark the previous latest history row as superseded
    await tx
      .update(factHistory)
      .set({ supersededAt: new Date(), supersededBy: agentId })
      .where(
        and(
          eq(factHistory.scope, scope),
          eq(factHistory.key, key),
          eq(factHistory.version, previousVersion),
        ),
      );

    return { version: nextVersion, created: false };
  });
}

export async function getFactHistory(scope: string, key: string) {
  if (!isValidFactKey(key)) {
    throw new FactHistoryError("Invalid fact key", 400);
  }
  const [current] = await db
    .select()
    .from(sharedFacts)
    .where(and(eq(sharedFacts.scope, scope), eq(sharedFacts.key, key)))
    .limit(1);

  const history = await db
    .select()
    .from(factHistory)
    .where(and(eq(factHistory.scope, scope), eq(factHistory.key, key)))
    .orderBy(desc(factHistory.version));

  return {
    scope,
    key,
    current: current
      ? {
          key: current.key,
          value: current.value,
          version: current.version,
          updated_by: current.updatedBy,
          updated_at: current.updatedAt.toISOString(),
        }
      : null,
    history: history.map((row) => ({
      version: row.version,
      value: row.value,
      set_by: row.setBy,
      set_at: row.setAt.toISOString(),
      reason: row.reason ?? null,
      source_message_id: row.sourceMessageId ?? null,
      source_thread_id: row.sourceThreadId ?? null,
      superseded_at: row.supersededAt ? row.supersededAt.toISOString() : null,
      superseded_by: row.supersededBy ?? null,
    })),
    count: history.length,
  };
}
