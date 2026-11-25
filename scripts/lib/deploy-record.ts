/**
 * The deploy record decisions (#249), shared by `scripts/deploy-record.ts` and its tests.
 *
 * The record must be evidence, not "the merge happened": a production merge is recorded only after
 * the deployment says which commit it is serving and that it can serve. Anything else is recorded
 * as unverified, because a record that says "ok" for a deployment nobody checked is worse than no
 * record at all.
 *
 * `docs/deploys.md` is frozen (#249); the durable record is the release `deploy/production/<sha7>`
 * plus the PR comment this module renders.
 */

export type VerceState = "success" | "failure" | "error" | "pending" | "timeout";

export type VersionBody = { commit?: string; env?: string };

export type ReadyBody = { ok?: boolean; migrations?: string };

export type Probe = {
  vercel: VerceState;
  version: VersionBody | null;
  ready: ReadyBody | null;
  /** Which probe hit its deadline, when one did. */
  timedOut?: "vercel" | "version" | "ready" | null;
};

export type Decision = {
  /** The verifiable result written into the row: `ok` or `FAILED …`. */
  result: string;
  ok: boolean;
  /** The deployment's own migrations state (`exact`, `ahead`, …) or `unknown`. */
  migrations: string;
  /** A release is created for any Vercel-built deployment, verified or not. */
  releaseEligible: boolean;
  /** Machine-readable cause for the CLI's warning line. */
  reason: "ok" | "vercel" | "version" | "env" | "readiness";
};

export const WORKFLOW_MARKER = "<!-- deploy-record-workflow -->";
/** Written by `scripts/deploy.sh`; the workflow must never overwrite it. */
export const SCRIPT_MARKER = "<!-- deploy-record -->";

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Deterministic, so a rerun or a scripted deploy cannot create a second release for one commit. */
export function releaseTag(sha: string): string {
  return `deploy/production/${shortSha(sha)}`;
}

export function decideRecord(sha: string, probe: Probe): Decision {
  const migrations = probe.ready?.migrations ?? "unknown";

  if (probe.vercel !== "success") {
    const why = probe.timedOut === "vercel" ? "timeout" : probe.vercel;
    return {
      result: `FAILED not deployed (Vercel ${why})`,
      ok: false,
      migrations,
      releaseEligible: false,
      reason: "vercel",
    };
  }

  if (!probe.version) {
    return {
      result: "FAILED unverified (version unavailable)",
      ok: false,
      migrations,
      releaseEligible: true,
      reason: "version",
    };
  }

  if (probe.version.env !== "production") {
    return {
      result: `FAILED unverified (env ${probe.version.env ?? "unknown"})`,
      ok: false,
      migrations,
      releaseEligible: true,
      reason: "env",
    };
  }

  if (probe.version.commit !== sha) {
    const serving = probe.version.commit ? shortSha(probe.version.commit) : "unknown";
    return {
      result: `FAILED unverified (version ${serving})`,
      ok: false,
      migrations,
      releaseEligible: true,
      reason: "version",
    };
  }

  if (!probe.ready || probe.ready.ok !== true) {
    return {
      result: "FAILED unverified (readiness)",
      ok: false,
      migrations,
      releaseEligible: true,
      reason: "readiness",
    };
  }

  return { result: "ok", ok: true, migrations, releaseEligible: true, reason: "ok" };
}

export function commentBody(input: {
  header: string;
  row: string;
  decision: Decision;
  tag: string | null;
}): string {
  const verdict = input.decision.ok
    ? "Verified by `.github/workflows/deploy-record.yml`: `/api/version` reported this commit and `/api/ready` reported `ok`."
    : "**Unverified.** The commit reached `main`, but its deployment identity was not confirmed. The deploy itself is unaffected; see the workflow run.";
  const release = input.tag ? `Release: \`${input.tag}\`.` : "No release: the deployment was not confirmed.";
  return [
    WORKFLOW_MARKER,
    "### Deploy record",
    "",
    input.header,
    input.row,
    "",
    verdict,
    release,
    "",
    "Written by `.github/workflows/deploy-record.yml` (#249).",
    "",
  ].join("\n");
}

export function releaseBody(input: {
  sha: string;
  pr: number | null;
  timestamp: string;
  decision: Decision;
}): string {
  return [
    `Production deploy of \`${shortSha(input.sha)}\` (PR #${input.pr ?? "—"}, ${input.timestamp}).`,
    `Migrations: ${input.decision.migrations}. Verification: ${input.decision.result}.`,
    "",
    "Recorded by `.github/workflows/deploy-record.yml` (#249).",
    "",
  ].join("\n");
}

export function recordRow(input: {
  sha: string;
  pr: number | null;
  timestamp: string;
  decision: Decision;
}): Record<string, string> {
  return {
    timestamp: input.timestamp,
    env: "production",
    sha: input.sha,
    pr: input.pr === null ? "—" : String(input.pr),
    migrations: input.decision.migrations,
    result: input.decision.result,
    rollback: "—",
  };
}
