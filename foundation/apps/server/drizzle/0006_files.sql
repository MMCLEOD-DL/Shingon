CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"team_id" uuid,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"attached_type" text,
	"attached_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "files_name_length_check" CHECK (char_length("files"."original_name") <= 200),
	CONSTRAINT "files_content_type_check" CHECK ("files"."content_type" in ('image/jpeg','image/png','image/webp','image/heic','application/pdf'))
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_owner_id_idx" ON "files" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "files_team_id_idx" ON "files" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "files_unattached_idx" ON "files" USING btree ("created_at") WHERE "files"."attached_type" is null;