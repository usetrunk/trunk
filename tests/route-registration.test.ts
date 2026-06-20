import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE_PREFIX_BY_FILE: Record<string, string> = {
  "agents.ts": "/agents",
  "attachments.ts": "/attachments",
  "audit.ts": "/audit-events",
  "billing.ts": "/billing",
  "connect.ts": "/connect",
  "contacts.ts": "/contacts",
  "context.ts": "/context",
  "dashboard.ts": "/dashboard",
  "documents.ts": "/documents",
  "messages.ts": "/messages",
  "rooms.ts": "/rooms",
  "slack.ts": "/slack",
  "tasks.ts": "/tasks",
  "templates.ts": "/templates",
  "workspaces.ts": "/workspaces",
};

describe("route registration", () => {
  it("mounts every route module in app.ts", () => {
    const routeFiles = readdirSync(join(process.cwd(), "src/routes"))
      .filter((file) => file.endsWith(".ts"))
      .sort();
    const appSource = readFileSync(join(process.cwd(), "src/app.ts"), "utf8");

    expect(routeFiles).toEqual(Object.keys(ROUTE_PREFIX_BY_FILE).sort());

    for (const routeFile of routeFiles) {
      const routeName = basename(routeFile, ".ts");
      const expectedPrefix = ROUTE_PREFIX_BY_FILE[routeFile];
      const importPattern = new RegExp(`import\\s+\\w+Routes\\s+from\\s+["']\\./routes/${routeName}\\.js["'];`);
      const mountPattern = new RegExp(`app\\.route\\(["']${expectedPrefix}["'],\\s*\\w+Routes\\);`);

      expect(appSource, `${routeFile} must be imported`).toMatch(importPattern);
      expect(appSource, `${routeFile} must be mounted at ${expectedPrefix}`).toMatch(mountPattern);
    }
  });
});
