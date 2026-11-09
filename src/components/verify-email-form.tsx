"use client";
import { useState } from "react";
import type { Locale } from "@/lib/i18n";

export function VerifyEmailForm({ locale }: { locale: Locale }) {
  const es = locale === "es";
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/verify/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, locale }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 429) {
        setError(es
          ? "Demasiados intentos. Espera unos minutos antes de volver a intentarlo."
          : "Too many attempts. Wait a few minutes before trying again.");
      } else if (!response.ok) {
        setError(data.error ?? (es
          ? "No pudimos enviar el correo. Inténtalo de nuevo."
          : "We could not send the email. Please try again."));
      } else {
        setMessage(es
          ? "Si existe una cuenta con ese correo, enviamos un nuevo enlace de verificación."
          : "If an account exists for that email, we sent a new verification link.");
      }
    } catch {
      setError(es
        ? "No pudimos conectar. Inténtalo de nuevo."
        : "Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form name="resend-verification" action="/api/auth/verify/request" method="post" onSubmit={submit} className="field-stack">
      <div>
        <label className="field-label" htmlFor="verify-email">{es ? "Correo electrónico" : "Email address"}</label>
        <input
          className="field-input"
          id="verify-email"
          name="email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="email"
          maxLength={254}
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={es ? "tu@ejemplo.com" : "you@example.com"}
        />
      </div>
      {message && <p className="success">{message}</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <button type="submit" className="button button-full" disabled={loading}>
        {loading
          ? (es ? "Enviando…" : "Sending…")
          : (es ? "Reenviar verificación" : "Resend verification")}
      </button>
    </form>
  );
}
