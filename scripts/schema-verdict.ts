#!/usr/bin/env tsx
// schema-verdict.ts — classify the `verify.json` that migrate.yml writes (#236).
//
// Exit codes:
//   0  in-sync or drift (drift is information; the workflow decides by mode)
//   2  uninspectable — a guard/connection/parse failure, which must be red in every mode
//
// Usage: npx tsx scripts/schema-verdict.ts [verify.json]

import { readFileSync } from "node:fs";
import { classifySchemaVerdictText, verdictExitCode } from "../src/lib/schema-verdict";

const file = process.argv[2] ?? "verify.json";

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.log("schema_verdict=uninspectable");
  console.error(`ERROR cannot read ${file} — the database was not inspected`);
  process.exit(2);
}

const verdict = classifySchemaVerdictText(text);
console.log(`schema_verdict=${verdict.state}`);
if (verdict.state === "uninspectable") {
  console.error(`ERROR ${verdict.reason}`);
}
process.exit(verdictExitCode(verdict.state));
