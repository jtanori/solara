import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { VerifyEmailForm } from "@/components/verify-email-form";
import { getLocale } from "@/lib/i18n-server";

type VerifyStatus = "verified" | "used" | "expired" | "invalid" | "rate_limited" | "error";

const copy: Record<VerifyStatus, { en: { title: string; body: string }; es: { title: string; body: string } }> = {
  verified: {
    en: { title: "Your email is verified.", body: "You can now sign in and use every account feature." },
    es: { title: "Tu correo está verificado.", body: "Ya puedes iniciar sesión y usar todas las funciones de tu cuenta." },
  },
  used: {
    en: { title: "This link was already used.", body: "Request a new verification link below if you still need one." },
    es: { title: "Este enlace ya se utilizó.", body: "Solicita un nuevo enlace de verificación abajo si aún lo necesitas." },
  },
  expired: {
    en: { title: "This link has expired.", body: "Verification links expire after 24 hours. Request a new one below." },
    es: { title: "Este enlace caducó.", body: "Los enlaces de verificación caducan después de 24 horas. Solicita uno nuevo abajo." },
  },
  invalid: {
    en: { title: "This link is invalid.", body: "Check the link or request a new verification email below." },
    es: { title: "Este enlace no es válido.", body: "Revisa el enlace o solicita un nuevo correo de verificación abajo." },
  },
  rate_limited: {
    en: { title: "Too many attempts.", body: "Wait a few minutes before requesting another verification email." },
    es: { title: "Demasiados intentos.", body: "Espera unos minutos antes de solicitar otro correo de verificación." },
  },
  error: {
    en: { title: "We could not verify your email.", body: "Please try again or request a new verification link below." },
    es: { title: "No pudimos verificar tu correo.", body: "Inténtalo de nuevo o solicita un nuevo enlace de verificación abajo." },
  },
};

function normalizeStatus(value: string | undefined): VerifyStatus {
  return value === "verified" || value === "used" || value === "expired"
    || value === "invalid" || value === "rate_limited" || value === "error"
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

  return (
    <>
      <SiteHeader />
      <main className="auth-layout">
        <div className="auth-art">
          <div className="eyebrow">{es ? "TU CUENTA" : "YOUR ACCOUNT"}</div>
          <h1>{es ? "Un correo, una cuenta." : "One email, one account."}</h1>
          <p>{es
            ? "La verificación protege tu cuenta y desbloquea el pago y la eliminación de cuenta."
            : "Verification protects your account and unlocks checkout and account deletion."}</p>
        </div>
        <div className="auth-panel">
          <div className="auth-box">
            <h2>{message.title}</h2>
            <p>{message.body}</p>
            {status === "verified" ? (
              <Link href="/account" className="button button-full">
                {es ? "Iniciar sesión" : "Sign in"}
              </Link>
            ) : (
              <VerifyEmailForm locale={requestedLocale} />
            )}
            <p className="auth-legal">
              <Link href={status === "verified" ? "/dashboard" : "/account"}>
                {status === "verified"
                  ? (es ? "Ir a mi panel" : "Go to my dashboard")
                  : (es ? "Volver a iniciar sesión" : "Back to sign in")}
              </Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
