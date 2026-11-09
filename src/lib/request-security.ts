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

export function isBearerRequest(authorization: string | null): boolean {
  return authorization !== null && /^Bearer\s+\S+/i.test(authorization);
}

export type MutationOriginDecision =
  | { allowed: true; reason: "bearer" | "same-origin" | "same-fetch-site" }
  | {
      allowed: false;
      reason: "missing-origin" | "invalid-origin" | "foreign-origin" | "invalid-app-url";
    };

export function evaluateMutationOrigin(input: {
  origin: string | null;
  secFetchSite: string | null;
  host: string | null;
  appUrl: string | undefined;
  authorization: string | null;
  requestUrl: string;
}): MutationOriginDecision {
  if (isBearerRequest(input.authorization)) {
    return { allowed: true, reason: "bearer" };
  }

  let originHost: string | null = null;
  if (input.origin) {
    try {
      originHost = new URL(input.origin).host;
    } catch {
      return { allowed: false, reason: "invalid-origin" };
    }
  }

  if (!originHost) {
    const secFetchSite = input.secFetchSite?.trim().toLowerCase();
    if (secFetchSite === "same-origin") {
      return { allowed: true, reason: "same-fetch-site" };
    }
    return { allowed: false, reason: "missing-origin" };
  }

  let appHost: string | null = null;
  if (input.appUrl) {
    try {
      appHost = new URL(input.appUrl).host;
    } catch {
      return { allowed: false, reason: "invalid-app-url" };
    }
  } else if (process.env.NODE_ENV !== "development") {
    return { allowed: false, reason: "invalid-app-url" };
  }

  let requestHost = input.host;
  if (!requestHost) {
    try {
      requestHost = new URL(input.requestUrl).host;
    } catch {
      requestHost = null;
    }
  }

  if (appHost && originHost === appHost) {
    return { allowed: true, reason: "same-origin" };
  }
  if (requestHost && originHost === requestHost) {
    return { allowed: true, reason: "same-origin" };
  }
  return { allowed: false, reason: "foreign-origin" };
}
