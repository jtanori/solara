import { createHash } from "node:crypto";

const SENSITIVE_KEY = /password|token|secret|email|birth|stripe|authorization|cookie/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DATABASE_URL = /postgres(?:ql)?:\/\/[^\s"']+/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const STRIPE_KEY = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+\b/g;
const WEBHOOK_SECRET = /\bwhsec_[A-Za-z0-9]+\b/g;
const RESEND_KEY = /\bre_[A-Za-z0-9_]{8,}\b/g;
const QUERY_SECRET = /((?:password|token|apikey|secret|email)=)[^&\s]+/gi;
const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;
const LONG_OPAQUE = /\b[A-Za-z0-9+/=_-]{40,}\b/g;

export type LogFields = Record<string, unknown>;

export type RequestMeta = {
  requestId?: string;
  route: string;
};

export function requestMeta(request: Request): RequestMeta {
  let route = "/";
  try {
    route = new URL(request.url).pathname;
  } catch {
    route = "/";
  }
  return {
    requestId: request.headers.get("x-request-id") ?? undefined,
    route,
  };
}

export function redactString(value: string): string {
  return value
    .replace(DATABASE_URL, "[database-url]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(STRIPE_KEY, "[stripe-key]")
    .replace(WEBHOOK_SECRET, "[webhook-secret]")
    .replace(RESEND_KEY, "[mail-key]")
    .replace(EMAIL, "[email]")
    .replace(QUERY_SECRET, "$1[redacted]")
    .replace(LONG_HEX, "[hex]")
    .replace(LONG_OPAQUE, "[opaque]");
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactValue(value: unknown, key = ""): unknown {
  if (key && isSensitiveKey(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]),
    );
  }
  return value;
}

export type SafeError = {
  name: string;
  code?: string;
  message: string;
  stackHash?: string;
};

export function safeError(error: unknown): SafeError {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: "unknown error" };
  }

  const rawCode = (error as unknown as { code?: unknown }).code;
  const code = typeof rawCode === "string" ? rawCode : undefined;

  return {
    name: error.name || "Error",
    ...(code && /^[0-9A-Z]{5}$/.test(code) ? { code } : {}),
    message: code && /^[0-9A-Z]{5}$/.test(code)
      ? "database error"
      : redactString(error.message || "error"),
    ...(error.stack
      ? { stackHash: createHash("sha256").update(error.stack).digest("hex").slice(0, 16) }
      : {}),
  };
}

function emit(level: "error" | "warn" | "info", event: string, fields: LogFields): void {
  const { error, ...rest } = fields;
  const line = {
    level,
    event,
    time: new Date().toISOString(),
    ...(redactValue(rest) as Record<string, unknown>),
    ...(error !== undefined ? { error: safeError(error) } : {}),
  };

  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.info(serialized);
}

export const log = {
  error(event: string, fields: LogFields = {}): void {
    emit("error", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    emit("warn", event, fields);
  },
  info(event: string, fields: LogFields = {}): void {
    emit("info", event, fields);
  },
};
