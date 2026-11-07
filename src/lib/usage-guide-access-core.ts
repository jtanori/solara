import { isDevelopmentMode } from "@/lib/development";
import { isUsageAudience, usageAudienceFor, usageGuides } from "@/lib/usage-guide";
import type { AudienceGuide, UsageAudience } from "@/lib/usage-guide";
import type { Locale } from "@/lib/i18n";
import type { Role } from "@/lib/types";

export type UsageGuideUser = { role: Role; plan: "free" | "paid" } | null;

export type ResolveUsageGuideAccessOptions = {
  environment?: string;
  isDevelopment?: boolean;
  user: UsageGuideUser;
  requestedRole?: string | null;
  locale?: Locale;
};

export type ResolvedUsageGuideAccess = {
  guides: AudienceGuide[];
  activeAudience: UsageAudience;
};

/**
 * Resolve internal-document (usage-guide) access.
 *
 * Development: return all guides and honor a valid `?role=` override.
 * Non-development: deny unauthenticated access; signed-in users receive exactly one guide
 * matching their real role; ignore `?role=`.
 *
 * This is the testable core — no `server-only` guard. Import from
 * `@/lib/usage-guide-access` in server components to get the build-time
 * client-import protection.
 */
export function resolveUsageGuideAccess(
  options: ResolveUsageGuideAccessOptions,
): ResolvedUsageGuideAccess | null {
  const { environment, isDevelopment, user, requestedRole, locale = "en" } = options;
  const isDev = isDevelopment ?? isDevelopmentMode(environment);

  if (isDev) {
    const guides = usageGuides(locale);
    const activeAudience: UsageAudience = isUsageAudience(requestedRole)
      ? requestedRole
      : usageAudienceFor(user);
    return { guides, activeAudience };
  }

  // Non-development: deny anonymous
  if (!user) return null;

  const audience = usageAudienceFor(user);
  // usageGuides() is server-side static data; we load all 6 then filter to the single allowed
  // guide. The returned `guides` array is pre-filtered and must be passed through verbatim —
  // do not forward the full array to the client (see #13 "no other role content" criterion).
  const guides = usageGuides(locale);
  const single = guides.find((guide) => guide.id === audience);
  // Fail closed: unknown audience means deny (should not happen with valid Role mapping)
  if (!single) return null;
  // Ignore requestedRole entirely outside development
  return { guides: [single], activeAudience: audience };
}

/**
 * Alias for issue wording: internal-document access resolver.
 * Currently scoped to usage-guide documents.
 */
export const resolveInternalDocumentAccess = resolveUsageGuideAccess;
