import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { generationCache } from "@/db/schema";
import type { CachedSection, SectionCache, SectionCacheKey } from "@/readings/generate";

/**
 * Production SectionCache over `generation_cache`. Insert-only: on conflict it
 * does nothing, so the frozen original always wins (epic §4.2, §4.5). Reads
 * miss (not error) on any DB hiccup — a generation rerun is always safe.
 */
export class DbSectionCache implements SectionCache {
  async get(key: SectionCacheKey): Promise<CachedSection | null> {
    const rows = await db
      .select({
        model: generationCache.model,
        usage: generationCache.usage,
        costMxn: generationCache.costMxn,
        latencyMs: generationCache.latencyMs,
        output: generationCache.output,
      })
      .from(generationCache)
      .where(
        and(
          eq(generationCache.digestHash, key.digestHash),
          eq(generationCache.section, key.section),
          eq(generationCache.locale, key.locale),
          eq(generationCache.contentVersion, key.contentVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { output: row.output, model: row.model, usage: row.usage, costMxn: row.costMxn, latencyMs: row.latencyMs } : null;
  }

  async put(key: SectionCacheKey, value: CachedSection): Promise<void> {
    await db
      .insert(generationCache)
      .values({
        digestHash: key.digestHash,
        section: key.section,
        locale: key.locale,
        contentVersion: key.contentVersion,
        model: value.model,
        usage: value.usage,
        costMxn: value.costMxn,
        latencyMs: value.latencyMs,
        output: value.output,
      })
      .onConflictDoNothing();
  }
}
