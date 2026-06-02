CREATE TABLE "blocked_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"blocked_agent_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"contact_agent_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"contact_agent_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"contact_agent_id" text NOT NULL,
	"muted" integer DEFAULT 0 NOT NULL,
	"urgency_filter" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_room" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blocked_contacts" ADD CONSTRAINT "blocked_contacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_contacts" ADD CONSTRAINT "blocked_contacts_blocked_agent_id_agents_id_fk" FOREIGN KEY ("blocked_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_agent_id_agents_id_fk" FOREIGN KEY ("contact_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_agent_id_agents_id_fk" FOREIGN KEY ("contact_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_labels" ADD CONSTRAINT "message_labels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_contact_agent_id_agents_id_fk" FOREIGN KEY ("contact_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_contacts_unique_idx" ON "blocked_contacts" USING btree ("agent_id","blocked_agent_id");--> statement-breakpoint
CREATE INDEX "blocked_contacts_agent_idx" ON "blocked_contacts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "contact_notes_agent_idx" ON "contact_notes" USING btree ("agent_id","contact_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_tags_unique_idx" ON "contact_tags" USING btree ("agent_id","contact_agent_id","tag");--> statement-breakpoint
CREATE INDEX "contact_tags_agent_idx" ON "contact_tags" USING btree ("agent_id","tag");--> statement-breakpoint
CREATE INDEX "contact_tags_contact_idx" ON "contact_tags" USING btree ("agent_id","contact_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_labels_unique_idx" ON "message_labels" USING btree ("message_id","agent_id","label");--> statement-breakpoint
CREATE INDEX "message_labels_agent_idx" ON "message_labels" USING btree ("agent_id","label");--> statement-breakpoint
CREATE INDEX "message_labels_message_idx" ON "message_labels" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_agent_name_idx" ON "message_templates" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "message_templates_agent_idx" ON "message_templates" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_unique_idx" ON "notification_preferences" USING btree ("agent_id","contact_agent_id");--> statement-breakpoint
CREATE INDEX "notification_prefs_agent_idx" ON "notification_preferences" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_searches_agent_name_idx" ON "saved_searches" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "saved_searches_agent_idx" ON "saved_searches" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_room_rooms_id_fk" FOREIGN KEY ("to_room") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_room_inbox_idx" ON "messages" USING btree ("to_room","status","created_at");