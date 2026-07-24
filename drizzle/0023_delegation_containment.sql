ALTER TABLE "agent_delegations" ADD COLUMN "containment" text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;
