import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { assertDatabaseEnvironment } from "./src/db/url-guard";

// Migrations are the direct-endpoint path (#168). Prefer an explicitly direct
// URL and refuse a pooled host; `db-run` is the supported hosted runner.
const url = process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_DIRECT or DATABASE_URL is required for Drizzle Kit");

assertDatabaseEnvironment(url, {
  deployEnv: process.env.APP_DEPLOY_ENV?.trim() || "local",
  forMigration: true,
  phase: "runtime",
});

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url },
});
