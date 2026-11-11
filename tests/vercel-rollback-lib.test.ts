import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The rollback helpers are shell, sourced by deploy.sh. Exercise the pure ones through bash so the
// logic is tested rather than asserted about.

function bash(script: string): string {
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, `bash failed: ${result.stderr}`);
  return result.stdout;
}

const SOURCE = 'set -euo pipefail; source scripts/lib/vercel-rollback.sh;';

test("vercel_deployment_id_from_url normalises both Vercel URL shapes", () => {
  const out = bash(`${SOURCE}
for u in \\
  "https://vercel.com/jtanori/solara/ABC123def" \\
  "https://vercel.com/jtanori/solara/dpl_XYZ789" \\
  "https://example.com/no-id/"; do
  printf '%s\\n' "$(vercel_deployment_id_from_url "$u")"
done`);
  // Do NOT trim: the third line is expected to be empty and trim() would drop it.
  const lines = out.replace(/\n$/, "").split("\n");
  assert.equal(lines[0], "dpl_ABC123def", "bare short id gains the dpl_ prefix");
  assert.equal(lines[1], "dpl_XYZ789", "an existing dpl_ prefix is not doubled");
  assert.equal(lines[2], "", "a URL with no id segment yields nothing rather than garbage");
});

test("deploy_ready_ok requires both HTTP 200 and ok:true", () => {
  const out = bash(`${SOURCE}
t=$(mktemp); printf '{"ok":true}' > "$t"; bad=$(mktemp); printf '{"ok":false}' > "$bad"
deploy_ready_ok 200 "$t" && echo "200+true:pass" || echo "200+true:fail"
deploy_ready_ok 500 "$t" && echo "500+true:pass" || echo "500+true:fail"
deploy_ready_ok 200 "$bad" && echo "200+false:pass" || echo "200+false:fail"
empty=$(mktemp)
deploy_ready_ok 200 "$empty" && echo "200+empty:pass" || echo "200+empty:fail"
rm -f "$t" "$bad" "$empty"`);
  assert.deepEqual(out.trim().split("\n"), [
    "200+true:pass",
    "500+true:fail",
    "200+false:fail",
    "200+empty:fail",
  ]);
});

test("a rollback with no credentials prints manual steps instead of failing silently", () => {
  const out = bash(`${SOURCE}
print_manual_rollback "solara" "dpl_PREVIOUS" "my-app-abc.vercel.app" 2>&1`);
  assert.match(out, /Roll back manually/);
  assert.match(out, /dpl_PREVIOUS/);
  assert.match(out, /Promote to Production/);
});

test("a rollback with no captured target still tells the operator what to do", () => {
  const out = bash(`${SOURCE}
print_manual_rollback "solara" "" "" 2>&1`);
  assert.match(out, /last known-good/);
});
