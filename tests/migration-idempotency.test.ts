import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("database migrations", () => {
  it("keeps the redundant shared_facts version migration idempotent", () => {
    const initialMigration = readFileSync(
      join(process.cwd(), "drizzle", "0003_playbook_protocol.sql"),
      "utf8",
    );
    const followUpMigration = readFileSync(
      join(process.cwd(), "drizzle", "0006_happy_tombstone.sql"),
      "utf8",
    );

    expect(initialMigration).toMatch(/CREATE TABLE "shared_facts"[\s\S]*"version" integer DEFAULT 1 NOT NULL/);
    expect(followUpMigration).toMatch(
      /ALTER TABLE "shared_facts" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL;/,
    );
  });
});
