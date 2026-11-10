import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { VerifyEmailClaim } from "@/components/verify-email-claim";
import { VerifyEmailForm } from "@/components/verify-email-form";
import { getLocale } from "@/lib/i18n-server";

type VerifyStatus = "claim" | "verified" | "claimed" | "used" | "expired" | "invalid" | "rate_limited" | "error";

const copy: Record<VerifyStatus, { en: { title: string; body: string }; es: { title: string; body: string } }> = {
  claim: {
    en: { title: "Choose your password.", body: "Claim your account from the link in your email, or request a new claim link below." },
    es: { title: "Elige tu contraseña.", body: "Reclama tu cuenta desde el enlace de tu correo o solicita uno nuevo abajo." },
  },
  verified: {
    en: { title: "Your account is active.", body: "You can sign in with the password you chose." },
    es: { title: "Tu cuenta está activa.", body: "Ya puedes iniciar sesión con la contraseña que elegiste." },
  },
  claimed: {
    en: { title: "Your account is active.", body: "You can sign in with the password you chose." },
    es: { title: "Tu cuenta está activa.", body: "Ya puedes iniciar sesión con la contraseña que elegiste." },
  },
  used: {
    en: { title: "This link was already used.", body: "Request a new claim link below if you still need one." },
    es: { title: "Este enlace ya se utilizó.", body: "Solicita un nuevo enlace abajo si aún lo necesitas." },
  },
  expired: {
    en: { title: "This link has expired.", body: "Claim links expire after 24 hours. Request a new one below." },
    es: { title: "Este enlace caducó.", body: "Los enlaces caducan después de 24 horas. Solicita uno nuevo abajo." },
  },
  invalid: {
    en: { title: "This link is invalid.", body: "Check the link or request a new claim email below." },
    es: { title: "Este enlace no es válido.", body: "Revisa el enlace o solicita un nuevo correo abajo." },
  },
  rate_limited: {
    en: { title: "Too many attempts.", body: "Wait a few minutes before requesting another claim email." },
    es: { title: "Demasiados intentos.", body: "Espera unos minutos antes de solicitar otro correo." },
  },
  error: {
    en: { title: "We could not claim your account.", body: "Please try again or request a new claim link below." },
    es: { title: "No pudimos reclamar tu cuenta.", body: "Inténtalo de nuevo o solicita un nuevo enlace abajo." },
  },
};

function normalizeStatus(value: string | undefined): VerifyStatus {
  if (!value) return "claim";
  return value === "verified" || value === "claimed" || value === "used"
    || value === "expired" || value === "invalid" || value === "rate_limited" || value === "error"
    ? value
    : "invalid";
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; lang?: string }>;
}) {
  const [params, locale] = await Promise.all([searchParams, getLocale()]);
  const requestedLocale = params.lang === "es" ? "es" : params.lang === "en" ? "en" : locale;
  const status = normalizeStatus(params.status);
  const message = copy[status][requestedLocale];
  const es = requestedLocale === "es";
  const active = status === "verified" || status === "claimed";

  return (
    <>
      <SiteHeader />
      <main className="auth-layout">
        <div className="auth-art">
          <div className="eyebrow">{es ? "TU CUENTA" : "YOUR ACCOUNT"}</div>
          <h1>{es ? "Un correo, una cuenta." : "One email, one account."}</h1>
          <p>{es
            ? "Reclama tu cuenta desde tu correo y elige tu propia contraseña antes de iniciar sesión."
            : "Claim your account from your email and choose your own password before signing in."}</p>
        </div>
        <div className="auth-panel">
          <div className="auth-box">
            <h2>{message.title}</h2>
            <p>{message.body}</p>
            {active ? (
              <Link href="/account" className="button button-full">
                {es ? "Iniciar sesión" : "Sign in"}
              </Link>
            ) : (
              <>
                <VerifyEmailClaim locale={requestedLocale} />
                <VerifyEmailForm locale={requestedLocale} />
              </>
            )}
            <p className="auth-legal">
              <Link href="/account">
                {es ? "Volver a iniciar sesión" : "Back to sign in"}
              </Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
