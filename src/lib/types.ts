import type { agents } from "../db/schema.js";
import type { GrantRecordT, GrantScopeT } from "../protocol/grants.js";
import type { DelegationEnvelope } from "./delegation-authorization.js";

export type AgentVariables = {
  Variables: {
    agentId: string;
    agent: typeof agents.$inferSelect;
    grant?: GrantRecordT;
    grantScopes?: GrantScopeT[];
    delegation?: DelegationEnvelope;
  };
};
