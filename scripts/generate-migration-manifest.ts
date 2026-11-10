#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type JournalEntry = { tag: string };

const journalPath = path.resolve("drizzle/meta/_journal.json");
const outputPath = path.resolve("src/lib/migration-manifest.ts");

function buildManifest(): string {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries?: JournalEntry[] };
  const entries = journal.entries ?? [];
  if (!entries.length) throw new Error("migration journal has no entries");

  const migrations = entries.map(entry => {
    const sql = readFileSync(path.resolve(`drizzle/${entry.tag}.sql`), "utf8");
    return { tag: entry.tag, hash: createHash("sha256").update(sql).digest("hex") };
  });

  return `export type MigrationManifestEntry = {
  tag: string;
  hash: string;
};

export const EXPECTED_MIGRATIONS: MigrationManifestEntry[] = ${JSON.stringify(migrations, null, 2)};
`;
}

function main() {
  const manifest = buildManifest();
  if (process.argv.includes("--check")) {
    const current = readFileSync(outputPath, "utf8");
    if (current !== manifest) {
      console.error("migration manifest is stale — run npm run db:manifest");
      process.exit(1);
    }
    console.log("migration manifest is up to date");
    return;
  }
  writeFileSync(outputPath, manifest);
  console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
}

main();
