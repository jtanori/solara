CREATE TABLE "generation_cache" (
	"digest_hash" text NOT NULL,
	"section" text NOT NULL,
	"locale" text NOT NULL,
	"content_version" text NOT NULL,
	"model" text NOT NULL,
	"usage" jsonb NOT NULL,
	"cost_mxn" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_cache_digest_hash_section_locale_content_version_pk" PRIMARY KEY("digest_hash","section","locale","content_version")
);
--> statement-breakpoint
CREATE TABLE "reading_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reading_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"content_version" text NOT NULL,
	"chart_version" text NOT NULL,
	"tier" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reading_documents" ADD CONSTRAINT "reading_documents_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_documents_reading_locale_version_key" ON "reading_documents" USING btree ("reading_id","locale","content_version");