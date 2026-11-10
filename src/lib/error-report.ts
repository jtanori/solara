import {
  MailAmbiguousError,
  MailConfigurationError,
  MailDeliveryError,
} from "@/lib/mail";

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

export function reportServerError(event: string, error: unknown): void {
  console.error(`[${event}]`, JSON.stringify({ category: safeErrorCategory(error) }));
}
