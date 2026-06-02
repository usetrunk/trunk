ALTER TABLE "messages" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_scheduled_idx" ON "messages" USING btree ("status","scheduled_at");