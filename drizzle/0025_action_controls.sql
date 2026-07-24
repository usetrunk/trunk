CREATE TABLE "workspace_action_controls" (
  "workspace_id" text PRIMARY KEY NOT NULL,
  "enabled" integer DEFAULT 0 NOT NULL,
  "confirmation_operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "quarantine_enabled" integer DEFAULT 0 NOT NULL,
  "quarantine_object_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "action_confirmations" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "operation" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "reviewed_by" text,
  "review_note" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone,
  "executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shared_object_quarantines" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "object_type" text NOT NULL,
  "object_id" text NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "reported_by" text NOT NULL,
  "reviewed_by" text,
  "review_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_action_controls" ADD CONSTRAINT "workspace_action_controls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_action_controls" ADD CONSTRAINT "workspace_action_controls_updated_by_agents_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_requested_by_agents_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "action_confirmations" ADD CONSTRAINT "action_confirmations_reviewed_by_agents_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shared_object_quarantines" ADD CONSTRAINT "shared_object_quarantines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shared_object_quarantines" ADD CONSTRAINT "shared_object_quarantines_reported_by_agents_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shared_object_quarantines" ADD CONSTRAINT "shared_object_quarantines_reviewed_by_agents_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "action_confirmations_workspace_idx" ON "action_confirmations" USING btree ("workspace_id","status","created_at");
--> statement-breakpoint
CREATE INDEX "action_confirmations_requester_idx" ON "action_confirmations" USING btree ("requested_by","created_at");
--> statement-breakpoint
CREATE INDEX "shared_object_quarantines_lookup_idx" ON "shared_object_quarantines" USING btree ("workspace_id","object_type","object_id","status");
--> statement-breakpoint
CREATE INDEX "shared_object_quarantines_workspace_idx" ON "shared_object_quarantines" USING btree ("workspace_id","status","created_at");
