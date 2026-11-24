import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { log } from "@/lib/log";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type MailTransportName = "resend" | "postmark" | "outbox";

export class MailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailConfigurationError";
  }
}

export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

export class MailAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAmbiguousError";
  }
}

type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new MailConfigurationError(`${name} is required to send email.`);
  return value;
}

export function resolveMailTransportName(env: Environment = process.env): MailTransportName {
  const configured = env.MAIL_TRANSPORT?.trim().toLowerCase();
  if (configured) {
    if (configured === "resend" || configured === "postmark" || configured === "outbox") {
      return configured;
    }
    throw new MailConfigurationError("MAIL_TRANSPORT must be resend, postmark, or outbox.");
  }
  if (env.NODE_ENV === "production") {
    throw new MailConfigurationError("MAIL_TRANSPORT is required in production.");
  }
  return "outbox";
}

async function sendResend(env: Environment, message: MailMessage): Promise<void> {
  const apiKey = required(env, "RESEND_API_KEY");
  const from = required(env, "MAIL_FROM");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(env.MAIL_REPLY_TO?.trim() ? { reply_to: env.MAIL_REPLY_TO.trim() } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new MailAmbiguousError("Resend delivery outcome is unknown.");
  }
  if (!response.ok) {
    if (response.status >= 500) {
      throw new MailAmbiguousError("Resend returned a server error; delivery outcome is unknown.");
    }
    throw new MailDeliveryError(`Resend rejected the message with status ${response.status}.`);
  }
}

async function sendPostmark(env: Environment, message: MailMessage): Promise<void> {
  const token = required(env, "POSTMARK_SERVER_TOKEN");
  const from = required(env, "MAIL_FROM");
  let response: Response;
  try {
    response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        From: from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        ...(env.MAIL_REPLY_TO?.trim() ? { ReplyTo: env.MAIL_REPLY_TO.trim() } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new MailAmbiguousError("Postmark delivery outcome is unknown.");
  }
  if (!response.ok) {
    if (response.status >= 500) {
      throw new MailAmbiguousError("Postmark returned a server error; delivery outcome is unknown.");
    }
    throw new MailDeliveryError(`Postmark rejected the message with status ${response.status}.`);
  }
}

async function sendOutbox(env: Environment, message: MailMessage): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new MailConfigurationError("The outbox transport is not allowed in production.");
  }
  const directory = path.join(process.cwd(), ".mail-outbox");
  await mkdir(directory, { recursive: true });
  const filename = `${Date.now()}-${randomBytes(4).toString("hex")}.eml`;
  const content = [
    `To: ${message.to}`,
    `From: ${env.MAIL_FROM?.trim() || "Solara <no-reply@solara.local>"}`,
    `Subject: ${message.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.text,
    "",
  ].join("\n");
  try {
    await writeFile(path.join(directory, filename), content, { encoding: "utf8", mode: 0o600 });
  } catch {
    throw new MailDeliveryError("Unable to write the local outbox message.");
  }
  log.info("mail.outbox_written", { filename, directory });
}

export type MailTransport = {
  name: MailTransportName;
  send(message: MailMessage): Promise<void>;
};

export function createMailTransport(env: Environment = process.env): MailTransport {
  const name = resolveMailTransportName(env);
  if (name === "outbox") {
    if (env.NODE_ENV === "production") {
      throw new MailConfigurationError("The outbox transport is not allowed in production.");
    }
    return { name, send: (message) => sendOutbox(env, message) };
  }
  required(env, "MAIL_FROM");
  if (name === "resend") {
    required(env, "RESEND_API_KEY");
    return { name, send: (message) => sendResend(env, message) };
  }
  required(env, "POSTMARK_SERVER_TOKEN");
  return { name, send: (message) => sendPostmark(env, message) };
}

export async function sendMail(message: MailMessage): Promise<void> {
  await createMailTransport().send(message);
}
