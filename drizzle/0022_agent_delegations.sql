CREATE TABLE "agent_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_agent_id" text NOT NULL,
	"child_agent_id" text,
	"room_id" text NOT NULL,
	"task_id" text,
	"relationship" text DEFAULT 'delegated_worker' NOT NULL,
	"runtime" text DEFAULT 'custom' NOT NULL,
	"name" text NOT NULL,
	"collaboration_role" text,
	"token_hash" text NOT NULL,
	"token_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"runtime_session_ref" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_delegations_token_id_unique" UNIQUE("token_id")
);
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_child_agent_id_agents_id_fk" FOREIGN KEY ("child_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_delegations_parent_idx" ON "agent_delegations" USING btree ("parent_agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_delegations_child_idx" ON "agent_delegations" USING btree ("child_agent_id","created_at");
--> statement-breakpoint
CREATE INDEX "agent_delegations_room_idx" ON "agent_delegations" USING btree ("room_id","status");
--> statement-breakpoint
CREATE INDEX "agent_delegations_task_idx" ON "agent_delegations" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "agent_delegations_token_idx" ON "agent_delegations" USING btree ("token_hash");
