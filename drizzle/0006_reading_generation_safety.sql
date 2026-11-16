CREATE TABLE "reading_generation_attempts" (
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
	CONSTRAINT "reading_attempts_section_check" CHECK ("reading_generation_attempts"."section" in ('overview','sun')),
	CONSTRAINT "reading_attempts_phase_check" CHECK ("reading_generation_attempts"."phase" in ('primary','repair')),
	CONSTRAINT "reading_attempts_state_check" CHECK ("reading_generation_attempts"."state" in ('reserved','measured','unknown','not_dispatched')),
	CONSTRAINT "reading_attempts_money_check" CHECK ("reading_generation_attempts"."reserved_micros" between 0 and 5000000 and ("reading_generation_attempts"."cost_micros" is null or "reading_generation_attempts"."cost_micros" between 0 and 9007199254740991)),
	CONSTRAINT "reading_attempts_settlement_check" CHECK (("reading_generation_attempts"."state" = 'reserved' and "reading_generation_attempts"."cost_micros" is null and "reading_generation_attempts"."settled_at" is null) or ("reading_generation_attempts"."state" <> 'reserved' and "reading_generation_attempts"."cost_micros" is not null and "reading_generation_attempts"."settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "reading_generation_consents" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"processor_id" text,
	"policy_version" text,
	"policy_hash" text,
	"locale" text NOT NULL,
	"granted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "reading_consents_revision_check" CHECK ("reading_generation_consents"."revision" >= 0),
	CONSTRAINT "reading_consents_locale_check" CHECK ("reading_generation_consents"."locale" in ('en', 'es')),
	CONSTRAINT "reading_consents_grant_check" CHECK ("reading_generation_consents"."granted_at" is null or ("reading_generation_consents"."policy_hash" is not null and "reading_generation_consents"."processor_id" is not null and "reading_generation_consents"."policy_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "reading_generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'lifetime_free' NOT NULL,
	"reading_id" uuid,
	"document_id" uuid,
	"locale" text NOT NULL,
	"status" text NOT NULL,
	"owner" uuid,
	"deadline" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"consent_revision" integer,
	"policy_hash" text,
	"config_hash" text,
	"content_version" text NOT NULL,
	"settings" jsonb,
	"ceiling_micros" integer DEFAULT 5000000 NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "reading_runs_kind_check" CHECK ("reading_generation_runs"."kind" = 'lifetime_free'),
	CONSTRAINT "reading_runs_locale_check" CHECK ("reading_generation_runs"."locale" in ('en', 'es')),
	CONSTRAINT "reading_runs_ceiling_check" CHECK ("reading_generation_runs"."ceiling_micros" = 5000000),
	CONSTRAINT "reading_runs_status_check" CHECK ("reading_generation_runs"."status" in ('reserved','running','completed','partial','failed','indeterminate','legacy')),
	CONSTRAINT "reading_runs_consumed_check" CHECK ("reading_generation_runs"."status" = 'reserved' or "reading_generation_runs"."consumed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "reading_generation_attempts" ADD CONSTRAINT "reading_generation_attempts_run_id_reading_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reading_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_generation_consents" ADD CONSTRAINT "reading_generation_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_generation_runs" ADD CONSTRAINT "reading_generation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_generation_runs" ADD CONSTRAINT "reading_generation_runs_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_generation_runs" ADD CONSTRAINT "reading_generation_runs_document_id_reading_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."reading_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_attempts_slot_key" ON "reading_generation_attempts" USING btree ("run_id","section","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "reading_attempts_outstanding_key" ON "reading_generation_attempts" USING btree ("run_id") WHERE "reading_generation_attempts"."state" = 'reserved';--> statement-breakpoint
CREATE UNIQUE INDEX "reading_runs_lifetime_user_key" ON "reading_generation_runs" USING btree ("user_id") WHERE "reading_generation_runs"."kind" = 'lifetime_free';--> statement-breakpoint
CREATE INDEX "reading_runs_reading_idx" ON "reading_generation_runs" USING btree ("reading_id");--> statement-breakpoint
CREATE INDEX "reading_runs_document_idx" ON "reading_generation_runs" USING btree ("document_id");
--> statement-breakpoint
-- Approved cutover rule: adopt a surviving, non-fixture generated free document.
-- Missing/deleted/unpersisted history is not reconstructed; no consent is inferred.
INSERT INTO reading_generation_runs (user_id, reading_id, document_id, locale, status, consumed_at, content_version, finished_at)
SELECT DISTINCT ON (r.user_id) r.user_id, r.id, d.id, d.locale, 'legacy', d.created_at, d.content_version, now()
FROM reading_documents d JOIN readings r ON r.id = d.reading_id
WHERE d.tier = 'free'
  AND jsonb_typeof(d.document->'models') = 'object'
  AND d.document->'models' <> '{}'::jsonb
  -- A nonempty object alone is not genuine provenance (e.g. {"overview":""}
  -- or a numeric model). Ambiguous rows remain for operator classification.
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(d.document->'models') = 'object' THEN d.document->'models' ELSE '{}'::jsonb END) m
    WHERE jsonb_typeof(m.value) <> 'string'
       OR (m.value #>> '{}') !~ '^[A-Za-z0-9._:/-]{1,128}$'
       OR (m.value #>> '{}') ILIKE 'fixture%'
  )
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.document->'sections') = 'array' THEN d.document->'sections' ELSE '[]'::jsonb END) section
    WHERE section->>'status' = 'generated'
      AND jsonb_typeof(d.document->'models'->(section->>'key')) = 'string'
  )
ORDER BY r.user_id, d.created_at, d.id
ON CONFLICT (user_id) WHERE kind = 'lifetime_free' DO NOTHING;
