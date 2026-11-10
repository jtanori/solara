import type { Locale } from "@/lib/i18n";

/**
 * The reading document domain model (`docs/plan-readings-engine-epic.md` §2).
 *
 * The persisted unit is a document of typed sections: the *facts* are computed
 * deterministically and stored on the reading; the *prose* is generated once
 * against a strict schema and then frozen. Paid prose is not generated at all
 * until entitlement (#107) — "blurred" means absent.
 */

export type SectionTier = "free" | "paid";
export type SectionStatus = "generated" | "overridden" | "failed";

/** Stable section ids (§2). `planetaryYear` and `transits` await engine facts (#110). */
export const SECTION_KEYS = [
  "overview",
  "sun",
  "moon",
  "ascendant",
  "aspects",
  "houses",
  "planets",
  "nodes",
  "planetaryYear",
  "transits",
  "guidance",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Ordered content blocks. The renderer (#106) tolerates unknown kinds. */
export type ReadingBlock =
  | { kind: "prose"; text: string }
  | { kind: "callout"; title?: string; text: string }
  | { kind: "list"; title?: string; items: string[] }
  | { kind: "keyValue"; title?: string; entries: { key: string; value: string }[] }
  | { kind: "aspectTable"; title?: string; rows: { a: string; b: string; type: string; orb: number }[] };

export type ReadingSection = {
  key: SectionKey;
  tier: SectionTier;
  title: string;
  subtitle?: string;
  blocks: ReadingBlock[];
  /** The chart facts this section is grounded in (for review + regeneration). */
  facts: Record<string, unknown>;
  status: SectionStatus;
  /** Set when status is "failed": why the fallback copy is showing. */
  failureReason?: string;
  /** The section's closing open question (required for the free cliffhanger sections). */
  closingQuestion?: string;
};

export type LockedSection = {
  key: SectionKey;
  title: string;
  teaser: string;
};

export type ReadingDocument = {
  id: string;
  readingId: string;
  locale: Locale;
  chartVersion: string;
  contentVersion: string;
  /** Provenance per generated word: model per section. */
  models: Partial<Record<SectionKey, string>>;
  generatedAt: string;
  tier: SectionTier;
  sections: ReadingSection[];
  lockedSections: LockedSection[];
  /**
   * Cost accounting, asserted against the tier ceiling: costMxn is the spend
   * that produced the published sections (cache hits add 0); wastedCostMxn is
   * spend on attempts that produced nothing (failed primaries, repairs, and
   * post-ceiling discards). Honest accounting records both.
   */
  costMxn: number;
  wastedCostMxn: number;
};
