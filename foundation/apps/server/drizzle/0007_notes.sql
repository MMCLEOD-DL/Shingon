CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"team_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"attachment_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_attachment_file_id_files_id_fk" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_team_created_idx" ON "notes" USING btree ("team_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notes_owner_created_idx" ON "notes" USING btree ("owner_id","created_at" DESC NULLS LAST);