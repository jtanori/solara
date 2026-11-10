import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runWait(states: string[], attempts = states.length) {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-wait-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const counter = path.join(dir, "counter");
  const cases = states
    .map((state, index) => `${index + 1}) printf '${state}\\n' ;;`)
    .join("\n      ");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
n=0
[[ -f "${counter}" ]] && n=$(cat "${counter}")
n=$((n + 1))
echo "$n" > "${counter}"
case "$n" in
      ${cases}
  *) printf '\\n' ;;
esac
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(bin, "sleep"), 0o755);

  const result = spawnSync(
    "bash",
    ["-c", `source scripts/lib/wait-for-vercel-status.sh; wait_for_vercel_status jtanori/solara abc123 Vercel ${attempts} 0`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    },
  );
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("waits through pending and succeeds on the Vercel success status", () => {
  const result = runWait(["pending\t", "success\thttps://vercel.example/deploy"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Vercel deployment ready for abc123/);
  assert.match(result.stdout, /https:\/\/vercel\.example\/deploy/);
});

test("fails immediately on a Vercel failure status", () => {
  const result = runWait(["failure\thttps://vercel.example/deploy"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Vercel status for abc123 is failure/);
  assert.match(result.stderr, /https:\/\/vercel\.example\/deploy/);
});

test("fails closed when Vercel never reports a status", () => {
  const result = runWait(["pending\t", "pending\t"], 2);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out waiting for a Vercel status/);
});
