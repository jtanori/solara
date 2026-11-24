"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Locale } from "@/lib/i18n";

export function VerifyEmailClaim({ locale }: { locale: Locale }) {
  const es = locale === "es";
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const value = params.get("token") ?? "";
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(value)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(value);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError(es ? "Las contraseñas no coinciden." : "Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/auth/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.error ?? (es
          ? "No pudimos reclamar tu cuenta. Inténtalo de nuevo."
          : "We could not claim your account. Please try again."));
        return;
      }
      setDone(true);
      setPassword("");
      setConfirmPassword("");
      setToken("");
    } catch {
      setError(es
        ? "No pudimos conectar. Inténtalo de nuevo."
        : "Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="field-stack">
        <p className="success">
          {es
            ? "Tu cuenta está reclamada. Ya puedes iniciar sesión con tu nueva contraseña."
            : "Your account is claimed. You can now sign in with your new password."}
        </p>
        <Link href="/account" className="button button-full">
          {es ? "Iniciar sesión" : "Sign in"}
        </Link>
      </div>
    );
  }

  if (!token) return null;

  return (
    <form name="claim-account" action="/api/auth/claim" method="post" onSubmit={submit} className="field-stack">
      <p className="small muted">
        {es
          ? "Elige una contraseña para activar tu cuenta. Este enlace solo puede usarse una vez."
          : "Choose a password to activate your account. This link can only be used once."}
      </p>
      <div>
        <label className="field-label" htmlFor="claim-password">{es ? "Nueva contraseña" : "New password"}</label>
        <input
          className="field-input"
          id="claim-password"
          name="password"
          type="password"
          minLength={10}
          maxLength={128}
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <div>
        <label className="field-label" htmlFor="claim-confirm">{es ? "Confirma la contraseña" : "Confirm password"}</label>
        <input
          className="field-input"
          id="claim-confirm"
          name="confirmPassword"
          type="password"
          minLength={10}
          maxLength={128}
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <button type="submit" className="button button-full" disabled={loading}>
        {loading
          ? (es ? "Activando…" : "Activating…")
          : (es ? "Reclamar mi cuenta" : "Claim my account")}
      </button>
    </form>
  );
}
