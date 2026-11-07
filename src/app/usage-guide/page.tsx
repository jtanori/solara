import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { currentUser } from "@/lib/auth";
import { isDevelopmentMode } from "@/lib/development";
import { getLocale } from "@/lib/i18n-server";
import { resolveUsageGuideAccess } from "@/lib/usage-guide-access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Solara | Usage guide", robots: { index: false, follow: false } };

export default async function UsageGuidePage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const [locale, user, params] = await Promise.all([getLocale(), currentUser(), searchParams]);
  const isDev = isDevelopmentMode();
  const resolved = resolveUsageGuideAccess({
    isDevelopment: isDev,
    user: user ? { role: user.role, plan: user.plan } : null,
    requestedRole: params.role ?? null,
    locale,
  });
  if (!resolved) notFound();
  const { UsageGuide } = await import("@/components/usage-guide");
  return (
    <>
      <SiteHeader />
      <UsageGuide
        guides={resolved.guides}
        locale={locale}
        initialAudience={resolved.activeAudience}
        signedInName={user?.name ?? null}
        isDevelopment={isDev}
      />
      <SiteFooter />
    </>
  );
}
