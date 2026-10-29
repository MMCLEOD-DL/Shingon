CREATE TABLE "ops_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"detail" text NOT NULL,
	"snapshot_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_runs_kind_check" CHECK ("ops_runs"."kind" in ('backup','restore-test','restore','update','audit-purge'))
);
--> statement-breakpoint
CREATE INDEX "ops_runs_kind_at_idx" ON "ops_runs" USING btree ("kind","at");