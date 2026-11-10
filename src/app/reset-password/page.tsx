import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { getLocale } from "@/lib/i18n-server";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const [params, locale] = await Promise.all([searchParams, getLocale()]);
  const requestedLocale = params.lang === "es" ? "es" : params.lang === "en" ? "en" : locale;
  const es = requestedLocale === "es";
  return (
    <>
      <SiteHeader />
      <main className="auth-layout">
        <div className="auth-art">
          <div className="eyebrow">{es ? "NUEVA CONTRASEÑA" : "NEW PASSWORD"}</div>
          <h1>{es ? "Un nuevo comienzo." : "A fresh start."}</h1>
          <p>{es
            ? "Elige una contraseña nueva para volver a entrar."
            : "Choose a new password to get back in."}</p>
        </div>
        <div className="auth-panel">
          <div className="auth-box">
            <h2>{es ? "Restablece tu contraseña." : "Reset your password."}</h2>
            <ResetPasswordForm locale={requestedLocale} />
            <p className="auth-legal">
              <Link href="/account">{es ? "Volver a iniciar sesión" : "Back to sign in"}</Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
