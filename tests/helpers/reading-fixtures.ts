import { readFileSync } from "node:fs";
import type { Locale } from "../../src/lib/i18n";
import type { ChartInput } from "../../src/lib/types";
import type { ReadingDocument } from "../../src/readings/types";
import type { StoredDocumentIdentity } from "../../src/readings/stored-document";

export function frozenReading(locale: Locale = "en", edition: "free" | "paid" | "partial-overview" | "partial-sun" = "free"): ReadingDocument {
  return JSON.parse(readFileSync(new URL(`../fixtures/readings/${edition}-${locale}.json`, import.meta.url), "utf8"));
}
export function documentIdentity(document: ReadingDocument): StoredDocumentIdentity {
  return { id: document.id, readingId: document.readingId, locale: document.locale,
    tier: document.tier, chartVersion: document.chartVersion, contentVersion: document.contentVersion };
}
export const readingChartInput: ChartInput = {
  name: "Synthetic Reading", birthDate: "1984-05-16", birthTime: "01:00", year: 2026,
  birthPlace: { name: "Mexicali, Mexico", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
  returnPlace: { name: "New York, United States", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
};
