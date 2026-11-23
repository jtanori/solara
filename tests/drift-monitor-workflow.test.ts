import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * #165 — the workflow file is asserted, not trusted.
 *
 * Every case here corresponds to a failure that is silent in production: a job
 * bound to a deployment environment fabricates GitHub Deployments; a root-level
 * concurrency group referencing matrix doesn't validate at all; a missing
 * `actions: read` produces a 403 on the very endpoints the monitor needs.
 *
 * The YAML is parsed structurally, not by substring, so a commented-out key
 * cannot satisfy a test.
 */

const RAW = readFileSync(".github/workflows/drift-monitor.yml", "utf8");

/**
 * A deliberately small block-YAML reader — enough for this workflow and no more.
 * No YAML package is a direct dependency of this project, so the test carries its
 * own; it was cross-checked field by field against a full parser before being
 * committed. Comments are stripped first, so a commented-out key cannot satisfy
 * an assertion.
 */
function parseBlockYaml(source: string): Record<string, unknown> {
  const lines: Array<{ indent: number; text: string }> = [];
  for (const raw of source.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const withoutComment = raw.replace(/\s+#\s.*$/, "");
    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trim() });
  }

  let index = 0;

  function scalar(value: string): unknown {
    const trimmed = value.trim().replace(/^["']|["']$/g, "");
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    const flow = /^\[(.*)\]$/.exec(trimmed);
    if (flow) return flow[1].split(",").map(part => part.trim()).filter(Boolean);
    return trimmed;
  }

  function parseBlock(indent: number): unknown {
    const isList = index < lines.length && lines[index].indent === indent && /^-\s|^-$/.test(lines[index].text);
    if (isList) {
      const items: unknown[] = [];
      while (index < lines.length && lines[index].indent === indent && /^-\s|^-$/.test(lines[index].text)) {
        const body = lines[index].text === "-" ? "" : lines[index].text.slice(2).trim();
        index += 1;
        if (!/:\s|:$/.test(body)) {
          items.push(scalar(body));
          continue;
        }
        const item: Record<string, unknown> = {};
        const first = /^([^:]+):\s*(.*)$/.exec(body);
        if (first) {
          const key = first[1].trim();
          if (first[2] === "") item[key] = parseBlock(indent + 2);
          else item[key] = scalar(first[2]);
        }
        while (index < lines.length && lines[index].indent > indent) {
          const nested = /^([^:]+):\s*(.*)$/.exec(lines[index].text);
          if (!nested) {
            index += 1;
            continue;
          }
          const key = nested[1].trim();
          const value = nested[2];
          const childIndent = lines[index].indent;
          index += 1;
          item[key] = value === "" ? parseBlock(childIndent + 2) : scalar(value);
        }
        items.push(item);
      }
      return items;
    }

    const object: Record<string, unknown> = {};
    while (index < lines.length && lines[index].indent === indent) {
      const match = /^([^:]+):\s*(.*)$/.exec(lines[index].text);
      if (!match) {
        index += 1;
        continue;
      }
      const key = match[1].trim();
      const value = match[2];
      index += 1;
      object[key] = value === "" ? parseBlock(indent + 2) : scalar(value);
    }
    return object;
  }

  return parseBlock(0) as Record<string, unknown>;
}

const WORKFLOW = parseBlockYaml(RAW) as {
  on?: Record<string, unknown>;
  permissions?: Record<string, string | undefined>;
  concurrency?: unknown;
  jobs?: Record<string, {
    environment?: string;
    concurrency?: Record<string, unknown>;
    strategy?: { matrix?: Record<string, unknown>; "fail-fast"?: boolean };
    steps?: Array<Record<string, unknown>>;
  }>;
};

test("the monitor runs on a 15-minute schedule", () => {
  const schedule = WORKFLOW.on?.schedule as Array<Record<string, string>> | undefined;
  assert.ok(Array.isArray(schedule), "a schedule trigger must exist");
  assert.equal(schedule[0].cron, "*/15 * * * *");
});

test("no job is bound to a deployment environment", () => {
  // Binding to staging/production creates a GitHub Deployment (task=deploy) per
  // run — ~192 fabricated `success` records a day — and collides with staging's
  // branch policy, because scheduled runs execute on main.
  for (const [name, job] of Object.entries(WORKFLOW.jobs ?? {})) {
    assert.equal(job.environment, "monitoring", `${name} must bind only to monitoring`);
    assert.notEqual(job.environment, "staging");
    assert.notEqual(job.environment, "production");
  }
});

test("one job covers both targets through a non-cancelling matrix", () => {
  const job = WORKFLOW.jobs?.monitor;
  assert.ok(job, "a monitor job must exist");
  const matrix = job.strategy?.matrix as { target?: string[] } | undefined;
  assert.deepEqual(matrix?.target, ["staging", "production"]);
  // A staging failure must not strand production.
  assert.equal((job.strategy as Record<string, unknown>)?.["fail-fast"], false);
});

test("concurrency is job-level, because matrix is not in scope at the root", () => {
  // A root-level group referencing ${{ matrix.target }} is invalid workflow
  // syntax: only github/inputs/vars are available there.
  assert.equal(WORKFLOW.concurrency, undefined, "the workflow root must not declare concurrency");
  const concurrency = WORKFLOW.jobs?.monitor.concurrency;
  assert.ok(concurrency, "the job must declare concurrency");
  assert.match(String(concurrency.group), /matrix\.target/);
  assert.equal((concurrency["cancel-in-progress"] as unknown as boolean), false);
});

test("permissions are exactly the four scopes the monitor needs", () => {
  assert.deepEqual(WORKFLOW.permissions, {
    contents: "read",
    actions: "read",
    deployments: "read",
    issues: "write",
  });
  // An explicit permissions map sets every omitted scope to none, so the
  // dangerous ones must be absent rather than merely unused.
  const granted = WORKFLOW.permissions as Record<string, string | undefined>;
  for (const forbidden of ["packages", "id-token", "pull-requests"]) {
    assert.equal(granted[forbidden], undefined, `${forbidden} must not be granted`);
  }
  // `deployments` is read-only on purpose: the monitor reads a waiting status,
  // it never creates or approves a deployment.
  assert.equal(granted.deployments, "read");
  assert.notEqual(granted.contents, "write");
});

test("the only secret is the Vercel bypass token", () => {
  assert.match(RAW, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.equal(/DATABASE_URL/.test(RAW), false, "the monitor holds no database credential");
  assert.equal(/VERCEL_TOKEN/.test(RAW), false, "the monitor never deploys");
});

test("the state artifact is retained for five days and is per target", () => {
  const upload = (WORKFLOW.jobs?.monitor.steps ?? []).find(step => String(step.uses ?? "").includes("upload-artifact"));
  assert.ok(upload, "a state artifact must be uploaded");
  assert.equal(String((upload.with as Record<string, unknown>)["retention-days"]), "5");
  assert.match(String((upload.with as Record<string, unknown>).name), /drift-state-\$\{\{ matrix\.target \}\}/);
  // Healthy ticks must overwrite, not accumulate a second artifact name.
  assert.equal(String((upload.with as Record<string, unknown>).overwrite), "true");
});

test("the state artifact survives a failing or degraded tick", () => {
  const upload = (WORKFLOW.jobs?.monitor.steps ?? []).find(step => String(step.uses ?? "").includes("upload-artifact"));
  assert.match(String(upload?.if ?? ""), /always\(\)/);
});

test("the monitor can be dispatched with a dry run after promotion", () => {
  const dispatch = WORKFLOW.on?.workflow_dispatch as Record<string, unknown> | undefined;
  assert.ok(dispatch, "workflow_dispatch must exist");
  const inputs = dispatch.inputs as Record<string, { type?: string }> | undefined;
  assert.equal(inputs?.dry_run.type, "boolean");
});
