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

// The database guard in src/db/url-guard.ts refuses to connect unless the target
// environment's endpoint label is present. migrate.yml never passed it, so every
// db-run.ts invocation aborted with `database_url_endpoint_unset` — production and
// staging alike — and in verify mode the failure was swallowed as a warning. A
// missing label must fail in the guard step with an actionable message instead.
test("every db-run step receives the endpoint label the database guard requires", () => {
  const steps = workflow.split(/\n      - name: /).slice(1);

  const dbRunSteps = steps.filter((step) => step.includes("scripts/db-run.ts"));
  assert.ok(dbRunSteps.length >= 3, `expected at least 3 db-run steps, found ${dbRunSteps.length}`);

  for (const step of dbRunSteps) {
    const name = step.split("\n")[0];
    const env = step.split(/\n        run:|\n          run:/)[0];
    for (const label of ["PROD_DB_ENDPOINT", "STAGING_DB_ENDPOINT"]) {
      assert.match(
        env,
        new RegExp(`vars\\.${label}`),
        `${name} must pass ${label} from environment variables, or the guard aborts`,
      );
    }
  }

  // And the guard step must reject a missing label before any connection attempt.
  assert.match(workflow, /EXPECTED_VAR is not set for environment/);
});

// #236: the step read only `ok`, so a guard/connection error that db-run reports through
// errors[] looked exactly like schema drift — and in verify mode produced a green
// "OUT OF SYNC". The classification is now a tested module and uninspectable is fatal.
test("the schema verdict is classified, not inferred from ok alone", () => {
  assert.match(workflow, /scripts\/schema-verdict\.ts verify\.json/);
  assert.match(workflow, /if \[ "\$VERDICT_RC" -ne 0 \]/);
  assert.match(workflow, /could not be inspected/);

  const classifier = workflow.indexOf("scripts/schema-verdict.ts verify.json");
  const readsOk = workflow.indexOf("String(j.ok)");
  assert.ok(classifier !== -1 && readsOk !== -1, "both the classifier and the drift read must exist");
  assert.ok(classifier < readsOk, "the verdict must be classified before ok is trusted");
});

// #236: --ref picks the workflow file and sha picks the checkout. Record both so a dispatch
// that executed a different file is visible in the run, even though the file cannot police
// its own staleness.
test("the run records which workflow file executed", () => {
  assert.match(workflow, /GITHUB_WORKFLOW_REF/);
  assert.match(workflow, /executed_from=\$\{GITHUB_SHA/);
  assert.match(workflow, /is not the target commit/);
});
