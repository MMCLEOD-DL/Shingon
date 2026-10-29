CREATE TABLE "user_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tokens_kind_check" CHECK ("user_tokens"."kind" in ('invite','reset'))
);
--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tokens_user_kind_idx" ON "user_tokens" USING btree ("user_id","kind");