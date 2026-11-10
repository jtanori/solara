import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SECTION_KEYS } from "@/readings/types";
import { sectionJsonSchema } from "@/readings/schemas";

/**
 * contentVersion (`docs/plan-readings-engine-epic.md` §4.5) — the version stamp
 * on everything a generated word depends on: prompt files, output schemas, and
 * the code-level generation policy. Bump POLICY_REVISION when a *code* policy
 * changes (validation rules, repair policy, prompt assembly in generate.ts);
 * file changes are picked up by hashing automatically.
 *
 * The version is a cache dimension: same digest + same version ⇒ reuse the
 * frozen row; new version ⇒ new rows, old rows preserved (freeze).
 */

const PROMPTS_DIR = path.join(process.cwd(), "src", "readings", "prompts");

const POLICY_REVISION = "1";

/**
 * Pure core: version from prompt file contents (name → bytes) and per-section
 * JSON Schemas. Deterministic and order-independent (names are sorted), so the
 * same sources always produce the same version and any edit to any source
 * produces a different one.
 */
export function contentVersionFromSources(
  promptFiles: Record<string, string>,
  schemas: Record<string, Record<string, unknown>>,
): string {
  const hash = createHash("sha256");
  hash.update(`policy:${POLICY_REVISION}\n`);
  for (const name of Object.keys(promptFiles).sort()) {
    hash.update(`file:${name}\n`);
    hash.update(promptFiles[name]);
    hash.update("\n");
  }
  for (const key of Object.keys(schemas).sort()) {
    hash.update(`schema:${key}\n`);
    hash.update(JSON.stringify(schemas[key]));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

let cached: string | undefined;

export function computeContentVersion(): string {
  if (cached) return cached;
  const files = readdirSync(PROMPTS_DIR).filter(file => file.endsWith(".md"));
  const promptFiles: Record<string, string> = {};
  for (const file of files) promptFiles[file] = readFileSync(path.join(PROMPTS_DIR, file), "utf8");
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const key of SECTION_KEYS) schemas[key] = sectionJsonSchema(key);
  cached = contentVersionFromSources(promptFiles, schemas);
  return cached;
}

/** Test seam: forget the memoized value so changed sources change the version. */
export function resetContentVersionCacheForTests(): void {
  cached = undefined;
}
