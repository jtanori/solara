import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { EXPECTED_MIGRATIONS } from "../src/lib/migration-manifest";

type JournalEntry = { tag: string; when: number };

test("migration manifest matches the journal, SQL hashes and ordering", () => {
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
    when: entry.when,
  }));

  assert.deepEqual(EXPECTED_MIGRATIONS, expected);
});

test("every manifest entry carries a positive integer when", () => {
  for (const entry of EXPECTED_MIGRATIONS) {
    assert.ok(Number.isSafeInteger(entry.when) && entry.when > 0, `${entry.tag} must have a positive integer when`);
  }
});

test("manifest when values are strictly increasing in journal order", () => {
  // ADR 012's `ahead` rule compares created_at with the newest expected `when`.
  // Equal or out-of-order journal timestamps would make that comparison ambiguous.
  for (let index = 1; index < EXPECTED_MIGRATIONS.length; index += 1) {
    const previous = EXPECTED_MIGRATIONS[index - 1];
    const current = EXPECTED_MIGRATIONS[index];
    assert.ok(
      current.when > previous.when,
      `${current.tag} (${current.when}) must be newer than ${previous.tag} (${previous.when})`,
    );
  }
});
