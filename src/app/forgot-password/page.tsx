import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { getLocale } from "@/lib/i18n-server";

export default async function ForgotPasswordPage() {
  const locale = await getLocale();
  const es = locale === "es";
  return (
    <>
      <SiteHeader />
      <main className="auth-layout">
        <div className="auth-art">
          <div className="eyebrow">{es ? "RECUPERA TU CUENTA" : "RECOVER YOUR ACCOUNT"}</div>
          <h1>{es ? "Volvamos a empezar." : "Let’s get you back in."}</h1>
          <p>{es
            ? "Te enviaremos un enlace seguro para elegir una contraseña nueva."
            : "We’ll send you a secure link to choose a new password."}</p>
        </div>
        <div className="auth-panel">
          <div className="auth-box">
            <h2>{es ? "¿Olvidaste tu contraseña?" : "Forgot your password?"}</h2>
            <p>{es
              ? "Si existe una cuenta verificada con tu correo, recibirás un enlace que caduca en una hora."
              : "If a verified account exists for your email, you’ll receive a link that expires in one hour."}</p>
            <ForgotPasswordForm locale={locale} />
            <p className="auth-legal">
              <Link href="/account">{es ? "Volver a iniciar sesión" : "Back to sign in"}</Link>
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
