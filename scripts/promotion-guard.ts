#!/usr/bin/env tsx
// promotion-guard.ts — the required check on pull requests into `main` (#244).
//
// Two questions, both answered without the GitHub API:
//   1. does this PR come from the integration branch (`staging`), not a feature branch or a fork?
//   2. does merging `main` into the head change anything? If it does, `main` carries content the
//      head lacks and the promotion would ship unreviewed changes.
//
// "Require branches to be up to date before merging" cannot express this: after every
// merge-commit promotion `main` is permanently one commit ahead of `staging`, and a back-merge is
// impossible (staging requires linear history, no bypass actors). This check replaces that
// setting with the property that actually matters: the merge result equals the tested head.
//
// Exit 0 accept, 1 refuse (actionable message on stderr), 2 usage or git failure.

import { mainOnlyCommits, promotionVerdict, PromotionGitError } from "./lib/promotion-verdict";

const env = process.env;
const repo = (env.REPO ?? "").trim();
const headRepo = (env.HEAD_REPO ?? "").trim();
const headRef = (env.HEAD_REF ?? "").trim();
const head = (env.HEAD_SHA ?? "").trim();
const base = (env.BASE_SHA ?? "").trim();

function refuse(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function usage(message: string): never {
  console.error(`ERROR ${message}`);
  process.exit(2);
}

if (!repo || !headRepo || !headRef || !head || !base) {
  usage("REPO, HEAD_REPO, HEAD_REF, HEAD_SHA and BASE_SHA are required");
}
if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(base)) {
  usage("HEAD_SHA and BASE_SHA must be full 40-character commit shas");
}

if (headRepo !== repo) {
  refuse(`Promotions must be opened from ${repo}; this pull request comes from the fork ${headRepo}.`);
}
if (headRef !== "staging") {
  refuse(
    `Pull requests into main must originate from \`staging\` (got \`${headRef}\`). ` +
      "Open the change against staging; a hotfix goes hotfix/* → staging → promotion.",
  );
}

try {
  const { verdict, conflicts } = promotionVerdict(head, base);
  if (verdict === "ancestor" || verdict === "content-contained") {
    console.log(`promotion ok: ${verdict} (${head.slice(0, 7)} over main@${base.slice(0, 7)})`);
    process.exit(0);
  }
  if (verdict === "needs-back-merge") {
    const commits = mainOnlyCommits(head, base);
    refuse(
      `main carries content \`${headRef}\` does not have:\n` +
        `${commits.map(commit => `  ${commit}`).join("\n")}\n` +
        `Re-land it on \`${headRef}\` through a normal pull request; do not back-merge.`,
    );
  }
  refuse(
    `merging main@${base.slice(0, 7)} into ${headRef}@${head.slice(0, 7)} conflicts:\n` +
      `${conflicts.length > 0 ? conflicts.map(file => `  ${file}`).join("\n") : "  (git reported a conflict without paths)"}\n` +
      `Resolve it on \`${headRef}\`.`,
  );
} catch (err) {
  const message = err instanceof PromotionGitError || err instanceof Error ? err.message : String(err);
  usage(message);
}
