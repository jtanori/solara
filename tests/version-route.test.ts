import assert from "node:assert/strict";
import test from "node:test";
import { createVersionHandler } from "../src/app/api/version/handler";
import type { BuildIdentity } from "../src/lib/build-identity";

const identity: BuildIdentity = {
  commit: "60c6deba3cbb19cde630242bc9ad1cbdf7cebd40",
  tree: "9c41f0c0f00d",
  release: "staging-60c6deb-1795378343",
  env: "staging",
  builtAt: "2026-11-22T20:12:23.632Z",
};

test("version returns exactly the six agreed keys", async () => {
  const GET = createVersionHandler(() => identity);
  const body = await (await GET()).json();
  assert.deepEqual(
    Object.keys(body).sort(),
    ["builtAt", "commit", "env", "ok", "release", "tree"],
    "an added field must be a deliberate edit, not a silent disclosure",
  );
});

test("version omits migrations until #167 defines the classifier", async () => {
  const GET = createVersionHandler(() => identity);
  const body = await (await GET()).json();
  assert.equal("migrations" in body, false);
});

test("version reports identity verbatim", async () => {
  const GET = createVersionHandler(() => identity);
  const body = await (await GET()).json();
  assert.equal(body.commit, identity.commit);
  assert.equal(body.tree, identity.tree);
  assert.equal(body.release, identity.release);
  assert.equal(body.env, identity.env);
  assert.equal(body.builtAt, identity.builtAt);
});

test("ok is always true and the status is always 200, even with no identity at all", async () => {
  const GET = createVersionHandler(() => ({
    commit: "unknown",
    tree: "unknown",
    release: "unknown",
    env: "local",
    builtAt: "unknown",
  }));
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("version is never cached", async () => {
  const GET = createVersionHandler(() => identity);
  assert.equal((await GET()).headers.get("cache-control"), "no-store");
});

test("the payload discloses no host, credential or migration tag", async () => {
  const GET = createVersionHandler(() => identity);
  const serialized = JSON.stringify(await (await GET()).json());
  for (const leak of ["postgres", "://", "DATABASE_URL", "drizzle/", ".vercel.app", "pooler"]) {
    assert.equal(serialized.includes(leak), false, `${leak} must not appear in the payload`);
  }
});
