import type { Locale } from "@/lib/i18n";
import type { SectionKey } from "@/readings/types";

/** Frozen manifests. A future registry addition must not change an old edition. */
export const PAID_CORE_SECTIONS = ["overview", "sun", "moon", "ascendant", "aspects", "houses", "planets", "nodes", "guidance"] as const satisfies readonly SectionKey[];
export const PAID_PROFILE = "paid-core-v1" as const;
export const PAID_RICH_PROFILE = "paid-rich-v1" as const;
export const PAID_PROFILES = [PAID_PROFILE, PAID_RICH_PROFILE] as const;
export type PaidProfile = typeof PAID_PROFILES[number];
export const PAID_RICH_SECTIONS = ["overview", "sun", "moon", "ascendant", "aspects", "houses", "planets", "nodes", "planetaryYear", "transits", "guidance"] as const satisfies readonly SectionKey[];
export function isPaidProfile(value: unknown): value is PaidProfile { return value === PAID_PROFILE || value === PAID_RICH_PROFILE; }
export function paidSections(profile: PaidProfile): readonly SectionKey[] { return profile === PAID_RICH_PROFILE ? PAID_RICH_SECTIONS : PAID_CORE_SECTIONS; }
export function paidPromptFile(key: SectionKey, locale: Locale): string {
  return `${["overview", "sun", "planetaryYear", "transits"].includes(key) ? "paid/" : ""}${key}.${locale}.md`;
}
export const PAID_ALLOWANCE_POLICY = "one-per-account-utc-month-v1";
export const PAID_CEILING_MICROS = 10_000_000;
export const PAID_RUN_MS = 10 * 60_000;
export const PAID_QUEUE_MS = 15 * 60_000;
export const PAID_LEASE_MS = 30_000;
export const PAID_HEARTBEAT_MS = 5_000;
export const PAID_EXECUTOR = "database-worker-v1";
export const PAID_STATES = ["queued", "preparing", "generating", "completed", "partial", "failed", "stopped", "attention"] as const;
export type PaidStatus = typeof PAID_STATES[number];
export const ACTIVE_PAID_STATES: PaidStatus[] = ["queued", "preparing", "generating"];

/** Public projections contain neither chart input nor provider/accounting records. */
export type PaidRunView = {
  id: string;
  readingId: string | null;
  locale: Locale;
  profile: PaidProfile;
  period: string;
  status: PaidStatus;
  completedSections: number;
  totalSections: number;
  allowanceConsumed: boolean;
  editionId: string | null;
  reason: string | null;
};
export type PaidOffer = {
  profile: PaidProfile;
  sections: readonly SectionKey[];
  houseSystem: "Placidus";
  locale: Locale;
  period: string;
  available: boolean;
  entitled: boolean;
  allowance: "available" | "reserved" | "consumed" | "attention";
  offerHash: string | null;
  runs: PaidRunView[];
  /** An explicit cursor, not automatic 'latest edition' selection. */
  nextCursor: string | null;
};
