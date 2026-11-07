import { SiteHeader } from "@/components/site-header";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { Wizard } from "@/components/wizard";
export default async function CreatePage({ searchParams }: { searchParams: Promise<{ name?: string }> }) {
  const [user, locale, params] = await Promise.all([currentUser(), getLocale(), searchParams]);
  return <><SiteHeader /><Wizard initialName={(params.name ?? user?.name ?? "").slice(0,100)} signedIn={!!user} currentYear={new Date().getFullYear()} locale={locale} /></>;
}
