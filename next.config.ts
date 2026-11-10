import type { NextConfig } from "next";
import {
  authenticatedCacheHeaders,
  privateReferrerHeaders,
  staticSecurityHeaders,
} from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@react-pdf/renderer"],
  // The reading pipeline reads prompt files from disk at runtime
  // (src/readings/content-version.ts, generate.ts). Turbopack builds don't
  // trace these reads, so include them explicitly or Vercel functions ship
  // without prompts and generation fails closed.
  outputFileTracingIncludes: {
    "/api/readings": ["./src/readings/prompts/**/*"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: staticSecurityHeaders(),
      },
      {
        source: "/reading/:path*",
        headers: [...privateReferrerHeaders, ...authenticatedCacheHeaders],
      },
      {
        source: "/dashboard/:path*",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/account/:path*",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/admin/:path*",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/usage-guide/:path*",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/api/readings/:path*",
        headers: [...privateReferrerHeaders, ...authenticatedCacheHeaders],
      },
      {
        source: "/api/auth/:path*",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/api/profile",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/api/admin/:path*",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/api/billing/checkout",
        headers: authenticatedCacheHeaders,
      },
      {
        source: "/api/billing/portal",
        headers: authenticatedCacheHeaders,
      },
    ];
  },
};

export default nextConfig;
