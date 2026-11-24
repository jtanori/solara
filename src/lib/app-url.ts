import { MailConfigurationError } from "@/lib/mail";

type Environment = Record<string, string | undefined>;

export function canonicalAppUrl(
  configured: string | undefined = process.env.APP_URL,
  env: Environment = process.env,
): string {
  const hosted = env.NODE_ENV === "production" || Boolean(env.VERCEL || env.VERCEL_ENV);
  const value = configured?.trim();

  if (!value) {
    if (hosted) {
      throw new MailConfigurationError("APP_URL is required to send account emails.");
    }
    return "http://localhost:3000";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MailConfigurationError("APP_URL must be a valid origin.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new MailConfigurationError("APP_URL must use http or https.");
  }
  if (hosted && url.protocol !== "https:") {
    throw new MailConfigurationError("APP_URL must use https in hosted environments.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new MailConfigurationError("APP_URL must be an origin without credentials, path, query, or fragment.");
  }

  return url.origin;
}
