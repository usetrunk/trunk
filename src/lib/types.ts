import type { agents } from "../db/schema.js";

export type AgentVariables = {
  Variables: {
    agentId: string;
    agent: typeof agents.$inferSelect;
  };
};
