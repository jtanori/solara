import { createHash } from "node:crypto";

/**
 * Canonical hashing, extracted from `@/readings/policy` so deterministic-identity
 * callers (chart saving, saved-fact validation, migration manifests) do not have to
 * import the module that also builds the provider HTTP adapter. Pure move: the
 * scheme, the bytes and every existing hash are unchanged, and `policy.ts`
 * re-exports all three names so no existing importer changes.
 */

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const CANONICAL_HASH_SCHEME = "json-utf16-v1";

/** JSON normalization, then recursive UTF-16 code-unit key order; arrays retain
 * order. Serialize keys directly so integer-like keys are NOT re-enumerated by
 * JSON.stringify's object rules. No host locale, ICU collation or normalization. */
export function canonicalHash(value: unknown): string {
  const ordered = (entry: unknown): string => Array.isArray(entry) ? `[${entry.map(ordered).join(",")}]`
    : entry !== null && typeof entry === "object"
      ? `{${Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${ordered(child)}`).join(",")}}`
      : JSON.stringify(entry);
  return createHash("sha256").update(ordered(JSON.parse(JSON.stringify(value)))).digest("hex");
}
