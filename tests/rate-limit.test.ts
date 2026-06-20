import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimits } from "../src/db/schema.js";
import { pruneStaleRateLimits } from "../src/lib/rate-limit.js";
import { db } from "../src/db/index.js";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const deleteMock = vi.fn(() => ({ where }));
  return { deleteMock, returning, where };
});

vi.mock("../src/db/index.js", () => ({
  db: {
    delete: mocks.deleteMock,
  },
}));

describe("rate-limit lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prunes stale rate-limit rows using updated_at retention", async () => {
    const now = new Date("2026-06-20T12:00:00.000Z");
    mocks.returning.mockResolvedValueOnce([{ scope: "read:agent-a" }, { scope: "write:agent-b" }]);

    const removed = await pruneStaleRateLimits(now, 60_000);

    expect(removed).toBe(2);
    expect(db.delete).toHaveBeenCalledWith(rateLimits);
    expect(mocks.where).toHaveBeenCalledTimes(1);
    expect(mocks.returning).toHaveBeenCalledWith({ scope: rateLimits.scope });
  });
});
