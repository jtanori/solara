import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getLocale } from "@/lib/i18n-server";
import "leaflet/dist/leaflet.css";
import "./globals.css";

/**
 * Metadata follows the request locale (#223). The layout already reads cookies, so
 * this adds no new dynamic surface; it just stops a Spanish page from advertising an
 * English title in a tab, a share card or a bookmark.
 */
export async function generateMetadata(): Promise<Metadata> {
  const es = (await getLocale()) === "es";
  return {
    title: es ? "Solara | Tu revolución solar" : "Solara | Your Solar Return",
    description: es
      ? "Explora tu revolución solar personal y un año más intencional."
      : "Explore your personal solar return and a more intentional year ahead.",
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return <html lang={locale}><body>{children}</body></html>;
}
