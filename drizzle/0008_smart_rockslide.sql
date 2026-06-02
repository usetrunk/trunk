ALTER TABLE "tasks" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "group" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "depends_on" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimate" integer;--> statement-breakpoint
CREATE INDEX "tasks_group_idx" ON "tasks" USING btree ("scope","group");