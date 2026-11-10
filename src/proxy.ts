import { NextResponse, type NextRequest } from "next/server";
import {
  evaluateMutationOrigin,
  isGuardedApiPath,
  isMutatingMethod,
} from "@/lib/request-security";
import {
  buildCsp,
  cspHeaderName,
  resolveCspMode,
} from "@/lib/security-headers";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function vercelOrigins(): string[] {
  return [
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.startsWith("http") ? value : `https://${value}`);
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isGuardedApiPath(pathname) && isMutatingMethod(request.method)) {
    const decision = evaluateMutationOrigin({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      appUrl: process.env.APP_URL,
      requestUrl: request.url,
      trustedOrigins: vercelOrigins(),
    });

    if (!decision.allowed) {
      return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
    }
  }

  if (isApiPath(pathname)) {
    return NextResponse.next();
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    appUrl: process.env.APP_URL,
    mapTileUrl: process.env.NEXT_PUBLIC_MAP_TILE_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set(cspHeaderName(resolveCspMode()), csp);
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|woff|woff2)$).*)",
  ],
};
