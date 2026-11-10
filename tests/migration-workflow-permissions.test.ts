import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("migration workflow grants the read permissions used by its production gate", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/migrate.yml"), "utf8");
  const permissions = workflow.match(/^permissions:\r?\n((?:  [^\r\n]+\r?\n)+)/m)?.[1];

  assert.ok(permissions, "workflow-level permissions block must be present");
  assert.match(permissions, /^  contents: read\r?$/m);
  assert.match(permissions, /^  actions: read\r?$/m);
  assert.match(permissions, /^  pull-requests: read\r?$/m);
});
