const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const UNGUARDED_API_PATHS = new Set([
  "/api/billing/webhook",
  "/api/csp-report",
]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function isGuardedApiPath(pathname: string): boolean {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return false;
  const normalized = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return !UNGUARDED_API_PATHS.has(normalized);
}

function normalizedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export type MutationOriginDecision =
  | { allowed: true; reason: "same-origin" | "same-fetch-site" }
  | {
      allowed: false;
      reason: "missing-origin" | "invalid-origin" | "foreign-origin";
    };

export function evaluateMutationOrigin(input: {
  origin: string | null;
  secFetchSite: string | null;
  appUrl: string | undefined;
  requestUrl: string;
  trustedOrigins?: string[];
}): MutationOriginDecision {
  const trusted = new Set<string>();
  for (const value of [input.appUrl, input.requestUrl, ...(input.trustedOrigins ?? [])]) {
    const origin = normalizedOrigin(value);
    if (origin) trusted.add(origin);
  }

  if (!input.origin) {
    const secFetchSite = input.secFetchSite?.trim().toLowerCase();
    if (secFetchSite === "same-origin") {
      return { allowed: true, reason: "same-fetch-site" };
    }
    return { allowed: false, reason: "missing-origin" };
  }

  const origin = normalizedOrigin(input.origin);
  if (!origin) return { allowed: false, reason: "invalid-origin" };
  if (trusted.has(origin)) return { allowed: true, reason: "same-origin" };
  return { allowed: false, reason: "foreign-origin" };
}
