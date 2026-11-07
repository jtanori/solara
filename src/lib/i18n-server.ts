import { cookies } from "next/headers";
import type { Locale } from "@/lib/i18n";

export async function getLocale(): Promise<Locale> {
  return (await cookies()).get("solara_locale")?.value === "es" ? "es" : "en";
}
