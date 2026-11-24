import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * #229 review: `/usage-guide` exported a static English title, which overrode the
 * locale-aware root metadata. Page metadata wins over layout metadata, so a static
 * export here silently defeats #223. This guards the shape; the rendered assertion
 * lives in scripts/verify-gating-production.ts, which fetches the page as a signed-in
 * reader in CI.
 */

const source = readFileSync(path.resolve("src/app/usage-guide/page.tsx"), "utf8");

test("the usage guide localizes its own title instead of hardcoding English", () => {
  assert.match(source, /export async function generateMetadata\(\)/);
  assert.doesNotMatch(source, /export const metadata/, "a static export would override the root locale metadata");
  assert.match(source, /Solara \| Guía de uso/);
  assert.match(source, /Solara \| Usage guide/);
});

test("the internal guide stays non-indexable in both locales", () => {
  assert.match(source, /robots: \{ index: false, follow: false \}/);
});

test("the page stays dynamic so the title can follow the request locale", () => {
  assert.match(source, /export const dynamic = "force-dynamic"/);
});
