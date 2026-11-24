import { cookies } from "next/headers";
import { resolveLocale, type Locale } from "@/lib/i18n";

/**
 * The request's locale. Spanish is the default (#223); the `solara_locale` cookie
 * selects English. `resolveLocale` is pure and unit-tested in isolation — this
 * wrapper adds only the Next request-scoped read.
 */
export async function getLocale(): Promise<Locale> {
  return resolveLocale((await cookies()).get("solara_locale")?.value);
}
