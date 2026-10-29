CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" text NOT NULL,
	"seeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_single_row" CHECK ("instance_settings"."id" = 1),
	CONSTRAINT "instance_settings_mode_check" CHECK ("instance_settings"."mode" in ('demo','production','test'))
);
