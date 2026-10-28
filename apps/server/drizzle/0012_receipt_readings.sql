CREATE TABLE "receipt_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"team_id" uuid,
	"status" text NOT NULL,
	"engine" text,
	"proposal" jsonb,
	"problem" text,
	"confirmed" jsonb,
	"corrected" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "receipt_readings_file_id_unique" UNIQUE("file_id"),
	CONSTRAINT "receipt_readings_status_check" CHECK ("receipt_readings"."status" in ('pending','read','unreadable','confirmed'))
);
--> statement-breakpoint
ALTER TABLE "receipt_readings" ADD CONSTRAINT "receipt_readings_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_readings" ADD CONSTRAINT "receipt_readings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_readings_status_created_idx" ON "receipt_readings" USING btree ("status","created_at");