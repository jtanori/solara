import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createDeploymentInputFixture, deploymentInputFiles } from "./helpers/deployment-inputs";

test("deployment input keeps PDF build/runtime assets but no local reading fixtures or runners", () => {
  const files = deploymentInputFiles();
  for (const path of [
    "scripts/build-pdf.mjs", "scripts/check-pdf-package.mjs",
    // npm ci must be able to install the local security backport in a preview.
    "vendor/solara-picomatch-v4-4.0.7-solara.2.tgz",
    "src/readings/pdf-worker.ts", "src/readings/pdf-bootstrap.mjs",
    "src/readings/fonts/LICENSE", "src/readings/fonts/noto-sans-latin-400-normal.woff",
    "src/readings/fonts/noto-sans-latin-700-normal.woff", "src/readings/fonts/noto-sans-latin-400-italic.woff",
  ]) {
    assert.ok(files.includes(path), `required deployment file missing: ${path}`);
  }
  for (const path of ["scripts/benchmark-reading-pdf.ts", "scripts/verify-reading-browser.ts", "scripts/verify-reading-mutations.mjs", "scripts/verify-dependency-mutations.mjs",
    "scripts/evaluate-paid-readings.ts", "scripts/approve-paid-reading-evaluation.ts", "scripts/lib/paid-evaluation-corpus.ts", "scripts/gen-annual-facts-fixtures.py"]) {
    assert.ok(!files.includes(path), `local-only reading tool would be deployed: ${path}`);
  }
  assert.ok(!files.some(path => path.startsWith("tests/")), "test fixtures must stay out of deployment input");
  assert.ok(!files.some(path => path.startsWith("scripts/local/")), "local seed code must stay out of deployment input");
  assert.ok(!files.some(path => /^\.env(?:\.|$)/.test(path) && path !== ".env.example"), "environment files must stay out of deployment input");
});

test("strict typecheck resolves every module after Vercel deployment exclusions", { timeout: 120_000 }, () => {
  const fixture = createDeploymentInputFixture();
  try {
    assert.ok(!existsSync(join(fixture.directory, "tests")));
    const config = JSON.parse(readFileSync(join(fixture.directory, "tsconfig.json"), "utf8"));
    assert.equal(config.compilerOptions.strict, true);
    assert.ok(config.include.includes("**/*.ts"));
    const result = spawnSync(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"), "--noEmit", "--incremental", "false"], {
      cwd: fixture.directory, encoding: "utf8", timeout: 110_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `deployment-input typecheck failed:\n${result.stdout}\n${result.stderr}`);
  } finally { fixture.cleanup(); }
});
