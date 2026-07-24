ALTER TABLE "audit_events" ADD COLUMN "outcome" text DEFAULT 'success' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "reason_code" text DEFAULT 'ACTION_COMPLETED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "credential_type" text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "credential_id" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "delegation_id" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "parent_agent_id" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "request_id" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "trace_id" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "provenance" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_delegation_id_agent_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."agent_delegations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_events_request_idx" ON "audit_events" USING btree ("request_id","created_at");
--> statement-breakpoint
CREATE INDEX "audit_events_decision_idx" ON "audit_events" USING btree ("actor_agent","outcome","reason_code","created_at");
