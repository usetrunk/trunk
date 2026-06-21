CREATE TABLE "agent_cards" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"schema" text DEFAULT 'trunk.agent_card.v1' NOT NULL,
	"description" text,
	"protocol" jsonb DEFAULT '[]' NOT NULL,
	"version" text DEFAULT '0.1.0' NOT NULL,
	"homepage_url" text,
	"documentation_url" text,
	"repository_url" text,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"message_types" jsonb DEFAULT '[]' NOT NULL,
	"endpoints" jsonb DEFAULT '[]' NOT NULL,
	"contact_policy" jsonb DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "scoped_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_agent_id" text NOT NULL,
	"created_by" text,
	"name" text NOT NULL,
	"description" text,
	"token_hash" text NOT NULL,
	"token_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]' NOT NULL,
	"audience_agent_id" text,
	"audience_workspace_id" text,
	"room_id" text,
	"expires_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoped_grants_token_id_unique" UNIQUE("token_id")
);
--> statement-breakpoint
ALTER TABLE "scoped_grants" ADD CONSTRAINT "scoped_grants_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoped_grants" ADD CONSTRAINT "scoped_grants_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoped_grants" ADD CONSTRAINT "scoped_grants_audience_agent_id_agents_id_fk" FOREIGN KEY ("audience_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoped_grants" ADD CONSTRAINT "scoped_grants_audience_workspace_id_workspaces_id_fk" FOREIGN KEY ("audience_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoped_grants" ADD CONSTRAINT "scoped_grants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scoped_grants_owner_idx" ON "scoped_grants" USING btree ("owner_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "scoped_grants_audience_idx" ON "scoped_grants" USING btree ("audience_agent_id");--> statement-breakpoint
CREATE TABLE "fact_history" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"source_message_id" text,
	"source_thread_id" text,
	"superseded_at" timestamp with time zone,
	"superseded_by" text
);
--> statement-breakpoint
ALTER TABLE "fact_history" ADD CONSTRAINT "fact_history_set_by_agents_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_history" ADD CONSTRAINT "fact_history_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_history" ADD CONSTRAINT "fact_history_superseded_by_agents_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_history_scope_key_idx" ON "fact_history" USING btree ("scope","key","version");--> statement-breakpoint
CREATE INDEX "fact_history_set_by_idx" ON "fact_history" USING btree ("set_by","set_at");--> statement-breakpoint
CREATE INDEX "fact_history_source_msg_idx" ON "fact_history" USING btree ("source_message_id");
