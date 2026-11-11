import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// #76's pre-merge gate lives in scripts/lib/vercel-preview.sh. Exercise the parsing and the polling
// loop for real (against a stub `curl`) rather than asserting on source text: a URL that resolves to
// the wrong project is exactly the kind of defect a presence test cannot see.

const SOURCE = 'set -euo pipefail; source scripts/lib/vercel-rollback.sh; source scripts/lib/vercel-preview.sh;';

function bash(script: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a Vercel inspector URL parses into team, project and deployment", () => {
  const out = bash(`${SOURCE}
vercel_preview_from_status_url "https://vercel.com/jaime-tanoris-projects/solara/dpl_6c8mp8c2ucTKe6Eqm5oKHpniznbR"
echo "---"
vercel_preview_from_status_url "https://vercel.com/jaime-tanoris-projects/solara/"
vercel_preview_from_status_url "https://dashboard.example.com/nothing/here"`).stdout;
  const [row] = out.split("\n");
  assert.deepEqual(row.split("\t"), ["jaime-tanoris-projects", "solara", "dpl_6c8mp8c2ucTKe6Eqm5oKHpniznbR"]);
  // A URL with no deployment id must yield nothing, not a truncated guess.
  assert.equal(out.split("\n").filter(line => line.includes("\t")).length, 1);
});

test("the branch alias follows Vercel's slug rules for the real ref shapes", () => {
  // Do NOT trim: the last alias is expected to be empty (no trailing newline) and must stay visible.
  const out = bash(`${SOURCE}
vercel_preview_alias solara jaime-tanoris-projects staging; echo
vercel_preview_alias solara jaime-tanoris-projects arena/4b7f8e03-solara; echo
vercel_preview_alias solara jaime-tanoris-projects feat/13-Usage_Guide; echo
vercel_preview_alias solara jaime-tanoris-projects "///"; echo`).stdout.split("\n");
  assert.equal(out[0], "https://solara-git-staging-jaime-tanoris-projects.vercel.app");
  assert.equal(out[1], "https://solara-git-arena-4b7f8e03-solara-jaime-tanoris-projects.vercel.app");
  // Uppercase and underscores both become a single dash, not two.
  assert.equal(out[2], "https://solara-git-feat-13-usage-guide-jaime-tanoris-projects.vercel.app");
  // A ref with no usable characters produces nothing rather than a dangling alias.
  assert.equal(out[3], "");
});

test("vercel_preview_url fails when neither the API nor the URL can name a preview", () => {
  const result = bash(`${SOURCE}
vercel_preview_url "https://wrong.example.com/x" "staging" "" || echo "EXIT:$?"`);
  assert.match(result.stdout, /could not resolve a preview URL/);
  assert.match(result.stdout, /EXIT:1/);
});

test("vercel_preview_url prefers the API hostname and falls back to the branch alias", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "preview-"));
  try {
    // Stub curl: emulate Vercel answering v13/deployments/<id> with a deployment hostname.
    const curl = path.join(dir, "curl");
    writeFileSync(curl, '#!/bin/sh\nprintf \'{"url":"solara-abc123-jaime-tanoris-projects.vercel.app"}\'\n');
    chmodSync(curl, 0o755);
    const withApi = bash(`${SOURCE}
vercel_preview_url "https://vercel.com/jaime-tanoris-projects/solara/dpl_abc123" staging ""`, {
      PATH: `${dir}:${process.env.PATH}`,
      VERCEL_TOKEN: "test-token",
    });
    assert.equal(withApi.stdout.trim(), "https://solara-abc123-jaime-tanoris-projects.vercel.app",
      "the deployment's own hostname, with https:// added");

    // No token: no API call is attempted, so the branch alias is used.
    const fallback = bash(`${SOURCE}
vercel_preview_url "https://vercel.com/jaime-tanoris-projects/solara/dpl_abc123" arena/4b7f8e03-solara ""`);
    assert.equal(fallback.stdout.trim(),
      "https://solara-git-arena-4b7f8e03-solara-jaime-tanoris-projects.vercel.app");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vercel_preview_ready stops at 401/403 instead of polling a protected host to timeout", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ready-"));
  try {
    const curl = path.join(dir, "curl");
    // Writes an "ok" body but returns 403 — exactly what Vercel Authentication does.
    writeFileSync(curl, '#!/bin/sh\nfor a in "$@"; do case "$a" in -o) out="$2";; esac; shift 2>/dev/null || break; done\necho \'{"ok":true}\' > /tmp/ignored\nprintf 403\n');
    chmodSync(curl, 0o755);
    const started = Date.now();
    const result = bash(`${SOURCE}
vercel_preview_ready "https://solara-git-staging-jaime-tanoris-projects.vercel.app" 12 5 "$(mktemp)" && echo "READY" || echo "NOT-READY:$?"`, {
      PATH: `${dir}:${process.env.PATH}`,
    });
    assert.match(result.stdout, /NOT-READY:1/);
    assert.match(result.stdout, /403/, "the last HTTP code is reported");
    assert.ok(Date.now() - started < 4000, "it gave up immediately rather than waiting out 12 x 5s");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vercel_preview_ready requires ok:true, not merely HTTP 200", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ready2-"));
  try {
    const curl = path.join(dir, "curl");
    // 200 with an unhealthy body must not count as ready.
    writeFileSync(curl, '#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\n[ -n "$out" ] && echo \'{"ok":false}\' > "$out"\nprintf 200\n');
    chmodSync(curl, 0o755);
    const result = bash(`${SOURCE}
vercel_preview_ready "https://x.vercel.app" 2 0 "$(mktemp)" && echo READY || echo "NOT-READY:$?"`, {
      PATH: `${dir}:${process.env.PATH}`,
    });
    assert.match(result.stdout, /NOT-READY:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
