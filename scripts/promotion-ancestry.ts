#!/usr/bin/env tsx
// promotion-ancestry.ts — can a promotion proceed when the base is not an ancestor? (#240, #244)
//
// After a merge-commit promotion, `main` carries a commit `staging` does not have. The gate's
// real question is not ancestry but content: does the head already contain everything `main`
// has? The logic lives in `scripts/lib/promotion-verdict.ts` so the required `promotion-guard`
// check and `deploy.sh` share one implementation.
//
// Output (one token on stdout, exit 0):
//   ancestor           base is an ancestor of head
//   content-contained  merging base into head is conflict-free and produces head's tree
//   needs-back-merge   the merge would add content from base
//   conflicted         the merge conflicts (or git could not compute it)
//
// On `conflicted`, the conflicting paths are written to stderr, one per line.
// Exit 2 on bad arguments or a git failure — never a verdict.
//
// Usage: npx tsx scripts/promotion-ancestry.ts --head <sha> --base <sha>

import { promotionVerdict, PromotionGitError, requireSha } from "./lib/promotion-verdict";

const argv = process.argv.slice(2);

function arg(flag: string): string {
  const index = argv.indexOf(flag);
  return index === -1 ? "" : (argv[index + 1] ?? "").trim();
}

try {
  const head = requireSha(arg("--head"), "--head");
  const base = requireSha(arg("--base"), "--base");
  const { verdict, conflicts } = promotionVerdict(head, base);
  if (conflicts.length > 0) console.error(conflicts.join("\n"));
  console.log(verdict);
} catch (err) {
  const message = err instanceof PromotionGitError || err instanceof Error ? err.message : String(err);
  console.error(`ERROR ${message}`);
  process.exit(2);
}
