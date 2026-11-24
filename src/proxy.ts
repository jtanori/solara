import { NextResponse, type NextRequest } from "next/server";
import {
  evaluateMutationOrigin,
  isGuardedApiPath,
  isMutatingMethod,
  vercelOrigins,
} from "@/lib/request-security";
import {
  buildCsp,
  cspHeaderName,
  resolveCspMode,
} from "@/lib/security-headers";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const requestId = crypto.randomUUID();

  if (isGuardedApiPath(pathname) && isMutatingMethod(request.method)) {
    const decision = evaluateMutationOrigin({
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      appUrl: process.env.APP_URL,
      requestUrl: request.url,
      trustedOrigins: vercelOrigins(),
    });

    if (!decision.allowed) {
      const response = NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
      response.headers.set("x-request-id", requestId);
      return response;
    }
  }

  if (isApiPath(pathname)) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-request-id", requestId);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-request-id", requestId);
    return response;
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    appUrl: process.env.APP_URL,
    mapTileUrl: process.env.NEXT_PUBLIC_MAP_TILE_URL,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set(cspHeaderName(resolveCspMode()), csp);
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|xml|woff|woff2)$).*)",
  ],
};
