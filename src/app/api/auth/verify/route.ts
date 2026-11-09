import { NextResponse } from "next/server";
import { consumeEmailToken } from "@/lib/email-verification";
import {
  AUTH_RATE_LIMITS,
  clientIp,
  consumeRateLimit,
  keyFor,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function redirectToStatus(
  request: Request,
  status: string,
  locale: "en" | "es",
): NextResponse {
  const base = process.env.APP_URL?.trim() || new URL(request.url).origin;
  const url = new URL("/verify-email", base);
  url.searchParams.set("status", status);
  url.searchParams.set("lang", locale);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get("token")?.trim() ?? "";
  const locale = params.get("lang") === "es" ? "es" : "en";

  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    return redirectToStatus(request, "invalid", locale);
  }

  try {
    const limit = await consumeRateLimit(
      keyFor("verify-token:ip", clientIp(request)),
      AUTH_RATE_LIMITS.verifyTokenIp,
      "verify_token_ip",
    );
    if (!limit.allowed) return redirectToStatus(request, "rate_limited", locale);

    const result = await consumeEmailToken(token);
    return redirectToStatus(request, result.status, locale);
  } catch (error) {
    console.error(
      "Email verification failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return redirectToStatus(request, "error", locale);
  }
}
