CREATE TABLE "account_lifecycle_leases" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"owner" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_lifecycle_leases_expires_idx" ON "account_lifecycle_leases" USING btree ("expires_at");