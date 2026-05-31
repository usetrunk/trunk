CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner" text,
	"secret_hash" text NOT NULL,
	"pairing_code" text NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_pairing_code_unique" UNIQUE("pairing_code")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"agent_a" text NOT NULL,
	"agent_b" text NOT NULL,
	"alias_a" text,
	"alias_b" text,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"from_agent" text NOT NULL,
	"to_agent" text NOT NULL,
	"thread_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_agent_a_agents_id_fk" FOREIGN KEY ("agent_a") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_agent_b_agents_id_fk" FOREIGN KEY ("agent_b") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_agent_agents_id_fk" FOREIGN KEY ("from_agent") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_agent_agents_id_fk" FOREIGN KEY ("to_agent") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_pair_idx" ON "contacts" USING btree ("agent_a","agent_b");--> statement-breakpoint
CREATE INDEX "messages_inbox_idx" ON "messages" USING btree ("to_agent","status","created_at");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","created_at");