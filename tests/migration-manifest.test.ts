import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { EXPECTED_MIGRATIONS } from "../src/lib/migration-manifest";

type JournalEntry = { tag: string };

test("migration manifest matches the journal and SQL hashes", () => {
  const journal = JSON.parse(
    readFileSync(path.resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as { entries?: JournalEntry[] };
  const entries = journal.entries ?? [];
  assert.ok(entries.length > 0, "journal must contain migrations");

  const expected = entries.map(entry => ({
    tag: entry.tag,
    hash: createHash("sha256")
      .update(readFileSync(path.resolve(`drizzle/${entry.tag}.sql`), "utf8"))
      .digest("hex"),
  }));

  assert.deepEqual(EXPECTED_MIGRATIONS, expected);
});
