CREATE TABLE "job_runs" (
	"job" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"summary" text,
	CONSTRAINT "job_runs_pkey" PRIMARY KEY("job","due_at"),
	CONSTRAINT "job_runs_summary_length" CHECK (char_length("job_runs"."summary") <= 500)
);
