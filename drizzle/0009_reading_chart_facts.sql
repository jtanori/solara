CREATE TABLE "reading_chart_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reading_id" uuid NOT NULL,
	"facts_version" text NOT NULL,
	"calculation_policy" text NOT NULL,
	"house_system" text NOT NULL,
	"chart_version" text NOT NULL,
	"facts" jsonb NOT NULL,
	"facts_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chart_facts_size_check" CHECK (octet_length("reading_chart_facts"."facts"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "reading_chart_facts" ADD CONSTRAINT "reading_chart_facts_reading_id_readings_id_fk" FOREIGN KEY ("reading_id") REFERENCES "public"."readings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reading_chart_facts_reading_version_key" ON "reading_chart_facts" USING btree ("reading_id","facts_version");