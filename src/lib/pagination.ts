/**
 * Cursor-based pagination utilities.
 *
 * Cursors are opaque base64-encoded strings containing `createdAt|id`.
 * Results are always ordered by createdAt DESC, so the cursor says
 * "give me results older than this point."
 */

export type PaginationParams = {
  limit: number;
  cursor?: { createdAt: Date; id: string };
};

export type PaginatedResult<T> = {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
};

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export function parsePaginationQuery(query: {
  limit?: string;
  cursor?: string;
}): PaginationParams {
  const limit = Math.min(
    Math.max(1, parseInt(query.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
    MAX_LIMIT
  );

  let cursor: PaginationParams["cursor"];
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
  }

  return { limit, cursor };
}

export function encodeCursor(createdAt: Date, id: string): string {
  const raw = `${createdAt.toISOString()}|${id}`;
  return Buffer.from(raw).toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx === -1) return undefined;
    const createdAt = new Date(raw.slice(0, pipeIdx));
    const id = raw.slice(pipeIdx + 1);
    if (isNaN(createdAt.getTime()) || !id) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

/**
 * Apply cursor-based pagination to an already-fetched array of rows.
 * Rows must be sorted by createdAt DESC.
 * Fetches limit+1 to determine has_more.
 */
export function paginateResults<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number
): PaginatedResult<T> {
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const next_cursor = has_more && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, next_cursor, has_more };
}
