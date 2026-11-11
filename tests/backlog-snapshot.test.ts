import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshot, GH_COMMAND, OUTPUT_PATH, type GhIssue } from "../scripts/backlog-snapshot";

function issue(partial: Partial<GhIssue> & { number: number; title: string }): GhIssue {
  return {
    labels: [],
    milestone: null,
    ...partial,
  };
}

const fixture: GhIssue[] = [
  issue({
    number: 205, title: "second priority | with a pipe", milestone: { title: "M2 - Billing" },
    labels: [{ name: "priority:p1" }, { name: "status:ready" }, { name: "type:feature" }],
  }),
  issue({
    number: 101, title: "top priority", milestone: { title: "M2 - Billing" },
    labels: [{ name: "priority:p0" }, { name: "status:blocked" }, { name: "area:infra" }],
  }),
  // Deliberately out of numeric order: priority:p2 in the same milestone, with the
  // lowest issue number, so a number-only sort would put it first instead of last.
  issue({
    number: 90, title: "lowest priority", milestone: { title: "M2 - Billing" },
    labels: [{ name: "priority:p2" }, { name: "type:docs" }],
  }),
  issue({
    number: 300, title: "no milestone here",
    labels: [{ name: "priority:p2" }],
  }),
];

const options = {
  issues: fixture,
  repo: "jtanori/solara",
  generatedAt: "2026-11-10T12:00:00Z",
  sha: "abcdef0123456789abcdef0123456789abcdef01",
};

test("snapshot header records provenance so freshness can be judged, not assumed", () => {
  const out = buildSnapshot(options);
  assert.match(out, /Generated: \*\*2026-11-10T12:00:00Z\*\* at `abcdef0`/);
  assert.match(out, /Repository: `jtanori\/solara`/);
  assert.ok(out.includes(GH_COMMAND), "the exact query is recorded");
  assert.match(out, /do not commit/i);
});

test("snapshot groups by milestone, orders priority before number, and puts 'No milestone' last", () => {
  const out = buildSnapshot(options);
  const billing = out.indexOf("## M2 - Billing (3)");
  const none = out.indexOf("## No milestone (1)");
  assert.ok(billing > 0 && none > billing, "groups are ordered, unmilestoned last");
  assert.ok(out.indexOf("#101") < out.indexOf("#205"), "priority:p0 sorts before priority:p1");
  // #90 has the lowest number in the group but the lowest priority, so it must sort last.
  assert.ok(out.indexOf("#205") < out.indexOf("#90"), "priority outranks issue number");
  assert.match(out, /4 open issues across 2 milestone\(s\)/);
});

test("snapshot extracts priority and status into their own columns", () => {
  const out = buildSnapshot(options);
  assert.match(out, /\| \[#101\][^\n]*\| priority:p0 \| status:blocked \| area:infra \|/);
  // A missing status renders an em dash rather than an empty cell or "undefined".
  assert.match(out, /\| \[#300\][^\n]*\| priority:p2 \| — \|/);
});

test("snapshot escapes pipes so a title cannot break the table", () => {
  const out = buildSnapshot(options);
  assert.match(out, /second priority \\\| with a pipe/);
  const row = out.split("\n").find(line => line.includes("#205"))!;
  // Exactly the table's own 6 pipes, plus the escaped one inside the title.
  assert.equal(row.split("|").length - 1, 7, "the escaped pipe does not add a column");
});

test("an empty issue list is stated, not rendered as a silently blank table", () => {
  const out = buildSnapshot({ ...options, issues: [] });
  assert.match(out, /No open issues/);
  assert.match(out, /token scope is wrong/);
});

test("the generator fails loudly on unreadable input instead of writing a partial file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "backlog-"));
  try {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    const result = spawnSync("npx", ["tsx", "scripts/backlog-snapshot.ts", "--input", bad], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "a bad payload is a non-zero exit");
    assert.match(result.stderr, /backlog:snapshot failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot output path is gitignored, which is what makes staleness impossible", () => {
  const relative = path.relative(process.cwd(), OUTPUT_PATH);
  assert.equal(relative, "docs/backlog-snapshot.md");
  const ignored = spawnSync("git", ["check-ignore", "-q", relative], { encoding: "utf8" });
  assert.equal(ignored.status, 0, `${relative} must be ignored by git`);
});

test("BACKLOG.md is gone and nothing in the tree still tells contributors to update it", () => {
  assert.equal(existsSync("BACKLOG.md"), false, "the tracked backlog file is deleted");

  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
  const liveDocs = tracked.filter(
    file =>
      (file.endsWith(".md") || file === ".github/pull_request_template.md") &&
      // Historical records legitimately mention the old file; a superseded note was added to them.
      ![
        // AGENTS.md lists ADR 002 by its historical title ("`BACKLOG.md` was an offline index…"),
        // so it names the old file without instructing anyone to update it.
        "AGENTS.md",
        "docs/decisions.md",
        "docs/backlog-review-2026-11-10.md",
        "docs/agent-workflow-rules-assessment.md",
        "docs/auth-neon-assessment.md",
        "docs/plan-issue-52-database-provisioning.md",
        "docs/operations/local-sync-and-issue-triage.md",
        "docs/operations/production-bootstrap-2026-11-10.md",
        "docs/operations/promotion-2026-11-10.md",
        "docs/critical-issues-2026-11-10.md",
      ].includes(file),
  );

  const offenders: string[] = [];
  for (const file of liveDocs) {
    const body = readFileSync(file, "utf8");
    if (/BACKLOG\.md/.test(body)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "no active document may instruct anyone to update BACKLOG.md");
});
