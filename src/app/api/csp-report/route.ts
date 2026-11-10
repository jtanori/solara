import { NextResponse } from "next/server";
import { log, requestMeta } from "@/lib/log";
import {
  AUTH_RATE_LIMITS,
  clientIp,
  consumeRateLimit,
  keyFor,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;
const ALLOWED_TYPES = new Set([
  "application/csp-report",
  "application/reports+json",
  "application/json",
]);

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return new URL(value).pathname;
  } catch {
    return value.startsWith("/") ? value.split("?")[0] : undefined;
  }
}

function safeBlocked(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value === "inline" || value === "eval" || value === "data" || value === "blob") {
    return value;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function readReport(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if ("csp-report" in value) {
    const report = (value as { "csp-report"?: unknown })["csp-report"];
    return report && typeof report === "object" ? report as Record<string, unknown> : null;
  }
  if ("body" in value) {
    const body = (value as { body?: unknown }).body;
    return body && typeof body === "object" ? body as Record<string, unknown> : null;
  }
  return value as Record<string, unknown>;
}

export async function POST(request: Request) {
  const context = requestMeta(request);
  const limit = await consumeRateLimit(
    keyFor("csp:ip", clientIp(request)),
    AUTH_RATE_LIMITS.cspReportIp,
    "csp_report_ip",
    context,
  );
  if (!limit.allowed) return new NextResponse(null, { status: 204 });

  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!contentType || !ALLOWED_TYPES.has(contentType)) {
    return new NextResponse(null, { status: 415 });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const report = readReport(parsed);
  if (!report) {
    return new NextResponse(null, { status: 400 });
  }

  log.warn("csp.violation", {
    ...context,
    documentPath: safePath(report["document-uri"]),
    directive: report["violated-directive"] ?? report["effective-directive"],
    blocked: safeBlocked(report["blocked-uri"]),
    disposition: report.disposition,
  });

  return new NextResponse(null, { status: 204 });
}
