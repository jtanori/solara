import type { BuildIdentity } from "@/lib/build-identity";
import { readAppIdentity } from "@/lib/build-identity";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * What `/api/version` returns. Deliberately excludes `migrations`: the four-state
 * classifier is #167, and synthesising it here would be a second, lossier copy
 * that #167 then has to delete (plan §4).
 *
 * Field names match `docs/plan-build-identity-164.md` §5 exactly so #165 and
 * #173 can be written against them without translation.
 */
export type PublicVersion = {
  ok: true;
  commit: string;
  tree: string;
  release: string;
  env: string;
  builtAt: string;
};

export function publicVersion(identity: BuildIdentity): PublicVersion {
  return {
    ok: true,
    commit: identity.commit,
    tree: identity.tree,
    release: identity.release,
    env: identity.env,
    builtAt: identity.builtAt,
  };
}

/**
 * `ok` is always true and the status is always 200. This endpoint reports
 * identity, not health: a build that cannot state its identity is a build that
 * should not have started, and returning `ok:false` here would make it a second
 * readiness endpoint with a different meaning. `/api/ready` owns health.
 */
export function createVersionHandler(
  identity: () => BuildIdentity = () => readAppIdentity(),
) {
  return function GET() {
    return Response.json(publicVersion(identity()), { status: 200, headers: NO_STORE });
  };
}
