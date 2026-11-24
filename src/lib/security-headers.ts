export type HeaderEntry = { key: string; value: string };

export type CspMode = "report-only" | "enforce";

type Environment = Record<string, string | undefined>;

export function resolveCspMode(env: Environment = process.env): CspMode {
  return env.CSP_MODE?.trim().toLowerCase() === "enforce" ? "enforce" : "report-only";
}

export function cspHeaderName(mode: CspMode): string {
  return mode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}

export function staticSecurityHeaders(env: Environment = process.env): HeaderEntry[] {
  const isHttpsApp = env.APP_URL?.startsWith("https://") ?? false;
  const isProduction = env.VERCEL_ENV
    ? env.VERCEL_ENV === "production"
    : env.NODE_ENV === "production" && isHttpsApp;

  const headers: HeaderEntry[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ];

  if (isProduction) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    });
  }

  return headers;
}

function addOrigin(origins: Set<string>, value: string | undefined): void {
  if (!value) return;
  try {
    origins.add(new URL(value).origin);
  } catch {
    return;
  }
}

export function buildCsp(input: {
  nonce: string;
  isDev: boolean;
  appUrl: string | undefined;
  mapTileUrl: string | undefined;
}): string {
  const imageOrigins = new Set<string>([
    "https://tile.openstreetmap.org",
    "https://*.tile.openstreetmap.org",
  ]);
  addOrigin(imageOrigins, input.mapTileUrl);

  const styleElementSource = input.isDev
    ? "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com"
    : `style-src-elem 'self' 'nonce-${input.nonce}' https://fonts.googleapis.com`;

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${input.isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' https://fonts.googleapis.com",
    styleElementSource,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com data:",
    `img-src 'self' blob: data: ${[...imageOrigins].join(" ")}`,
    `connect-src 'self'${input.isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "report-uri /api/csp-report",
  ];

  if (input.appUrl?.startsWith("https://")) {
    directives.push("upgrade-insecure-requests");
  }

  return `${directives.join("; ")};`;
}

export const authenticatedCacheHeaders: HeaderEntry[] = [
  { key: "Cache-Control", value: "private, no-store" },
];

export const privateReferrerHeaders: HeaderEntry[] = [
  { key: "Referrer-Policy", value: "no-referrer" },
];
