CREATE TABLE "message_edits" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"version" integer NOT NULL,
	"previous_payload" jsonb NOT NULL,
	"edited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "message_edits_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "message_edits_edited_by_agents_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_edits_message_idx" ON "message_edits" USING btree ("message_id","version");