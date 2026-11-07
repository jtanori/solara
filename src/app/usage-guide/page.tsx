import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { currentUser } from "@/lib/auth";
import { isDevelopmentMode } from "@/lib/development";
import { getLocale } from "@/lib/i18n-server";
import { isUsageAudience, usageAudienceFor, usageGuides } from "@/lib/usage-guide";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title:"Solara | Usage guide", robots:{index:false,follow:false} };

export default async function UsageGuidePage({searchParams}:{searchParams:Promise<{role?:string}>}) {
  // This check is server-side and runs before loading user data or guide content.
  if (!isDevelopmentMode()) notFound();
  const [{UsageGuide}, locale, user, params] = await Promise.all([
    import("@/components/usage-guide"), getLocale(), currentUser(), searchParams,
  ]);
  const initialAudience = isUsageAudience(params.role) ? params.role : usageAudienceFor(user);
  return <><SiteHeader /><UsageGuide guides={usageGuides(locale)} locale={locale} initialAudience={initialAudience} signedInName={user?.name ?? null} /><SiteFooter /></>;
}
