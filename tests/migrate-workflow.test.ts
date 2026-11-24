import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/migrate.yml", "utf8");

test("the production migration gate token can read PR metadata and actions", () => {
  const permissionsBlock = workflow
    .split("\nconcurrency:")[0]
    .split("\npermissions:")[1];

  assert.ok(permissionsBlock, "migrate.yml must declare workflow permissions");
  for (const scope of ["contents: read", "actions: read", "pull-requests: read"]) {
    assert.match(
      permissionsBlock,
      new RegExp(`^\\s*${scope}$`, "m"),
      `missing workflow permission: ${scope}`,
    );
  }

  assert.match(workflow, /gh pr view "\$REHEARSAL_PR"/);
  assert.match(workflow, /gh run download/);
});
