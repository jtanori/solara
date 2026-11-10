import {
  MailAmbiguousError,
  MailConfigurationError,
  MailDeliveryError,
} from "@/lib/mail";
import { log, type LogFields } from "@/lib/log";

export function safeErrorCategory(error: unknown): string {
  if (error instanceof MailConfigurationError) return "mail_configuration";
  if (error instanceof MailDeliveryError) return "mail_delivery";
  if (error instanceof MailAmbiguousError) return "mail_ambiguous";
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `db_${code}`;
  }
  return "unknown";
}

export function reportServerError(
  event: string,
  error: unknown,
  context: LogFields = {},
): void {
  log.error(event, {
    ...context,
    category: safeErrorCategory(error),
    error,
  });
}
