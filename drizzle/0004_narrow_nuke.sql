CREATE TABLE IF NOT EXISTS "shared_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text DEFAULT 'text/markdown' NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_edited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shared_document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"edited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_document_versions" ADD CONSTRAINT "shared_document_versions_document_id_shared_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."shared_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_document_versions" ADD CONSTRAINT "shared_document_versions_edited_by_agents_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_documents" ADD CONSTRAINT "shared_documents_last_edited_by_agents_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_doc_versions_idx" ON "shared_document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_docs_scope_idx" ON "shared_documents" USING btree ("scope","name");
