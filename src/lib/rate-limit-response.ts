/**
 * The HTTP shape of a rate-limit refusal — pure, no database import.
 *
 * Every limited route in the app returns the same 429 so a client (or a test)
 * can recognise it without knowing which route it came from: `code:
 * "rate_limited"`, a `Retry-After` header, and `no-store` so a shared cache
 * cannot hand the refusal to someone else.
 */

/** The 429 body + `Retry-After` every limited route returns. */
export function rateLimitedResponse(
  locale: "en" | "es",
  retryAfterSeconds: number,
  message?: { en: string; es: string },
): Response {
  const text = message?.[locale]
    ?? (locale === "es"
      ? "Demasiadas solicitudes. Inténtalo de nuevo más tarde."
      : "Too many requests. Please try again later.");
  return Response.json(
    { error: text, code: "rate_limited" },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, retryAfterSeconds)),
        "Cache-Control": "no-store",
      },
    },
  );
}
