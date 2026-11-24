CREATE TABLE "deleted_customers" (
	"stripe_customer_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
