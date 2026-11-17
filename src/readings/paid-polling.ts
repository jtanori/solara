import { isPaidProfile, paidSections, PAID_STATES, ACTIVE_PAID_STATES, type PaidOffer, type PaidRunView } from "@/readings/paid-contract";
import { pollBoundedStatus, type PollStop, type StatusPollEnvironment } from "@/readings/status-polling";
import type { Locale } from "@/lib/i18n";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isId = (value: unknown) => typeof value === "string" && uuid.test(value);
const period = (value: unknown) => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
export function publicPaidRun(value: unknown): PaidRunView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as PaidRunView;
  if (!isId(v.id) || !(v.readingId === null || isId(v.readingId)) || !(v.editionId === null || isId(v.editionId)) ||
    !["en", "es"].includes(v.locale) || !isPaidProfile(v.profile) || !period(v.period) || !PAID_STATES.includes(v.status) ||
    !Number.isInteger(v.completedSections) || v.completedSections < 0 || v.completedSections > paidSections(v.profile).length || v.totalSections !== paidSections(v.profile).length ||
    typeof v.allowanceConsumed !== "boolean" || !(v.reason === null || typeof v.reason === "string" && v.reason.length <= 100)) return null;
  return { id: v.id, readingId: v.readingId, editionId: v.editionId, locale: v.locale, profile: v.profile, period: v.period, status: v.status,
    completedSections: v.completedSections, totalSections: v.totalSections, allowanceConsumed: v.allowanceConsumed, reason: v.reason };
}
export function publicPaidOffer(value: unknown): PaidOffer | null {
  if (!value || typeof value !== "object") return null;
  const v = value as PaidOffer;
  if (!isPaidProfile(v.profile) || v.houseSystem !== "Placidus" || JSON.stringify(v.sections) !== JSON.stringify(paidSections(v.profile)) ||
    !["en", "es"].includes(v.locale) || !period(v.period) || typeof v.available !== "boolean" || typeof v.entitled !== "boolean" ||
    !["available", "reserved", "consumed", "attention"].includes(v.allowance) || !(v.offerHash === null || typeof v.offerHash === "string" && /^[a-f0-9]{64}$/.test(v.offerHash)) ||
    !(v.nextCursor === null || isId(v.nextCursor)) || !Array.isArray(v.runs) || v.runs.length > 20) return null;
  const runs = v.runs.map(publicPaidRun);
  if (runs.some(run => run === null)) return null;
  return { profile: v.profile, houseSystem: v.houseSystem, sections: [...paidSections(v.profile)], locale: v.locale, period: v.period,
    available: v.available, entitled: v.entitled, allowance: v.allowance, offerHash: v.offerHash, runs: runs as PaidRunView[], nextCursor: v.nextCursor };
}
export function pollPaidReadingStatus(options: {
  readingId: string; locale: Locale; immediate?: boolean; minimumDelay?: number;
  onView: (offer: PaidOffer) => void; onStop: (reason: PollStop, retryAt: number) => void;
}, environment?: StatusPollEnvironment) {
  return pollBoundedStatus({ ...options, url: `/api/readings/${options.readingId}/paid?locale=${options.locale}`, parse: publicPaidOffer,
    isActive: offer => offer.runs.some(run => ACTIVE_PAID_STATES.includes(run.status)) }, environment);
}
