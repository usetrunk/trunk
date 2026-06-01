CREATE TABLE "workspace_contacts" (
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"alias" text,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner" text,
	"pairing_code" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_pairing_code_unique" UNIQUE("pairing_code")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_workspace" text;--> statement-breakpoint
ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_contacts_idx" ON "workspace_contacts" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE INDEX "workspace_contacts_agent_idx" ON "workspace_contacts" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_workspace_workspaces_id_fk" FOREIGN KEY ("to_workspace") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_workspace_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_workspace_inbox_idx" ON "messages" USING btree ("to_workspace","status","created_at");