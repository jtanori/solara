CREATE TABLE "paid_reading_allowances" (
	"user_id" uuid NOT NULL,
	"period" text NOT NULL,
	"run_id" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "paid_reading_allowances_user_id_period_pk" PRIMARY KEY("user_id","period")
);
--> statement-breakpoint
CREATE TABLE "paid_reading_approvals" (
	"profile" text NOT NULL,
	"content_version" text NOT NULL,
	"locale" text NOT NULL,
	"config_hash" text NOT NULL,
	"sample_count" integer NOT NULL,
	"reviewer" text NOT NULL,
	"evidence" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "paid_reading_approvals_profile_content_version_locale_config_hash_pk" PRIMARY KEY("profile","content_version","locale","config_hash"),
	CONSTRAINT "paid_approvals_evidence_check" CHECK ("paid_reading_approvals"."sample_count" >= 6 and length("paid_reading_approvals"."reviewer") between 1 and 200 and length("paid_reading_approvals"."evidence") between 1 and 2000 and "paid_reading_approvals"."locale" in ('en','es'))
);
--> statement-breakpoint
CREATE TABLE "paid_reading_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"owner" uuid NOT NULL,
	"section" text NOT NULL,
	"phase" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"requested_model" text NOT NULL,
	"reported_model" text,
	"reserved_micros" bigint NOT NULL,
	"cost_micros" bigint,
	"usage" jsonb,
	"latency_ms" integer,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "paid_attempts_section_check" CHECK ("paid_reading_attempts"."section" in ('overview','sun','moon','ascendant','aspects','houses','planets','nodes','guidance') and "paid_reading_attempts"."phase" in ('primary','repair')),
	CONSTRAINT "paid_attempts_state_check" CHECK ("paid_reading_attempts"."state" in ('reserved','measured','unknown','not_dispatched')),
	CONSTRAINT "paid_attempts_money_check" CHECK ("paid_reading_attempts"."reserved_micros" between 1 and 10000000 and ("paid_reading_attempts"."cost_micros" is null or "paid_reading_attempts"."cost_micros" between 0 and 9007199254740991)),
	CONSTRAINT "paid_attempts_settlement_check" CHECK (("paid_reading_attempts"."state" = 'reserved' and "paid_reading_attempts"."cost_micros" is null and "paid_reading_attempts"."settled_at" is null) or ("paid_reading_attempts"."state" <> 'reserved' and "paid_reading_attempts"."cost_micros" is not null and "paid_reading_attempts"."settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "paid_reading_checkpoints" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"output" jsonb,
	CONSTRAINT "paid_checkpoints_output_check" CHECK (("paid_reading_checkpoints"."kind" = 'valid' and "paid_reading_checkpoints"."output" is not null and octet_length("paid_reading_checkpoints"."output"::text) <= 131072) or ("paid_reading_checkpoints"."kind" = 'invalid' and "paid_reading_checkpoints"."output" is null))
);
--> statement-breakpoint
CREATE TABLE "paid_reading_control" (
	"id" text PRIMARY KEY DEFAULT 'paid' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"worker_heartbeat_at" timestamp with time zone,
	"worker_config_hash" text,
	CONSTRAINT "paid_control_singleton_check" CHECK ("paid_reading_control"."id" = 'paid' and "paid_reading_control"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "paid_reading_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"reading_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"profile" text NOT NULL,
	"expected_sections" jsonb NOT NULL,
	"content_version" text NOT NULL,
	"chart_version" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_editions_size_check" CHECK (octet_length("paid_reading_editions"."document"::text) <= 524288 and octet_length("paid_reading_editions"."snapshot"::text) <= 131072)
);
--> statement-breakpoint
CREATE TABLE "paid_reading_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reading_id" uuid,
	"intent_id" uuid NOT NULL,
	"period" text NOT NULL,
	"allowance_policy" text NOT NULL,
	"locale" text NOT NULL,
	"profile" text NOT NULL,
	"expected_sections" jsonb NOT NULL,
	"content_version" text NOT NULL,
	"config_hash" text NOT NULL,
	"settings" jsonb NOT NULL,
	"policy_hash" text NOT NULL,
	"consent_revision" integer NOT NULL,
	"consent_receipt_id" uuid NOT NULL,
	"entitlement_id" text NOT NULL,
	"entitlement_until" timestamp with time zone NOT NULL,
	"control_revision" integer NOT NULL,
	"ceiling_micros" integer DEFAULT 10000000 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"completed_sections" integer DEFAULT 0 NOT NULL,
	"owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"deadline" timestamp with time zone,
	"queue_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "paid_runs_contract_check" CHECK ("paid_reading_runs"."profile" = 'paid-core-v1' and "paid_reading_runs"."allowance_policy" = 'one-per-account-utc-month-v1' and "paid_reading_runs"."ceiling_micros" = 10000000 and "paid_reading_runs"."locale" in ('en','es') and "paid_reading_runs"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "paid_runs_manifest_check" CHECK ("paid_reading_runs"."expected_sections" = '["overview","sun","moon","ascendant","aspects","houses","planets","nodes","guidance"]'::jsonb),
	CONSTRAINT "paid_runs_state_check" CHECK ("paid_reading_runs"."completed_sections" between 0 and 9 and "paid_reading_runs"."status" in ('queued','preparing','generating','completed','partial','failed','stopped','attention') and ("paid_reading_runs"."status" not in ('completed','partial') or "paid_reading_runs"."consumed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "paid_reading_snapshots" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"reading_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "paid_snapshots_size_check" CHECK (octet_length("paid_reading_snapshots"."snapshot"::text) <= 131072)
);
--> statement-breakpoint
ALTER TABLE "paid_reading_allowances" ADD CONSTRAINT "paid_reading_allowances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_allowances" ADD CONSTRAINT "paid_reading_allowances_run_id_paid_reading_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."paid_reading_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_attempts" ADD CONSTRAINT "paid_reading_attempts_run_id_paid_reading_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."paid_reading_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_checkpoints" ADD CONSTRAINT "paid_reading_checkpoints_attempt_id_paid_reading_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."paid_reading_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_checkpoints" ADD CONSTRAINT "paid_reading_checkpoints_run_id_paid_reading_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."paid_reading_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_checkpoints" ADD CONSTRAINT "paid_reading_checkpoints_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_editions" ADD CONSTRAINT "paid_reading_editions_run_id_paid_reading_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."paid_reading_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_editions" ADD CONSTRAINT "paid_reading_editions_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_runs" ADD CONSTRAINT "paid_reading_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_runs" ADD CONSTRAINT "paid_reading_runs_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_snapshots" ADD CONSTRAINT "paid_reading_snapshots_run_id_paid_reading_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."paid_reading_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reading_snapshots" ADD CONSTRAINT "paid_reading_snapshots_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_allowances_run_key" ON "paid_reading_allowances" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_attempts_slot_key" ON "paid_reading_attempts" USING btree ("run_id","section","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_attempts_outstanding_key" ON "paid_reading_attempts" USING btree ("run_id") WHERE "paid_reading_attempts"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "paid_checkpoints_run_idx" ON "paid_reading_checkpoints" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "paid_checkpoints_reading_idx" ON "paid_reading_checkpoints" USING btree ("reading_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_editions_run_key" ON "paid_reading_editions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "paid_editions_reading_idx" ON "paid_reading_editions" USING btree ("reading_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_runs_intent_key" ON "paid_reading_runs" USING btree ("user_id","intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_runs_active_user_key" ON "paid_reading_runs" USING btree ("user_id") WHERE "paid_reading_runs"."status" in ('queued','preparing','generating');--> statement-breakpoint
CREATE INDEX "paid_runs_queue_idx" ON "paid_reading_runs" USING btree ("created_at","id") WHERE "paid_reading_runs"."status" in ('queued','preparing','generating');--> statement-breakpoint
CREATE INDEX "paid_runs_reading_idx" ON "paid_reading_runs" USING btree ("reading_id","created_at","id");--> statement-breakpoint
CREATE INDEX "paid_runs_attention_idx" ON "paid_reading_runs" USING btree ("user_id") WHERE "paid_reading_runs"."status" = 'attention';--> statement-breakpoint
CREATE INDEX "paid_snapshots_reading_idx" ON "paid_reading_snapshots" USING btree ("reading_id");
--> statement-breakpoint
-- Disabled on installation. Worker presence alone must never activate generation.
INSERT INTO "paid_reading_control" ("id", "enabled", "revision") VALUES ('paid', false, 0);
--> statement-breakpoint
-- Editions are insert-only even if an application caller accidentally adds an
-- UPDATE path. Deletion still cascades for chart/account erasure.
CREATE FUNCTION public.reject_paid_edition_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'paid editions are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paid_editions_immutable BEFORE UPDATE ON public.paid_reading_editions
FOR EACH ROW EXECUTE FUNCTION public.reject_paid_edition_update();
--> statement-breakpoint
CREATE TRIGGER paid_snapshots_immutable BEFORE UPDATE ON public.paid_reading_snapshots
FOR EACH ROW EXECUTE FUNCTION public.reject_paid_edition_update();
