import Link from "next/link";
import type { Locale } from "@/lib/i18n";

export function VerifyEmailNotice({ locale }: { locale: Locale }) {
  const es = locale === "es";
  return (
    <div className="notice" style={{ marginBottom: 20 }}>
      <strong>{es ? "Verifica tu correo." : "Verify your email."}</strong>{" "}
      {es
        ? "Confirma tu dirección para habilitar el pago y la eliminación de cuenta."
        : "Confirm your address to enable checkout and account deletion."}{" "}
      <Link href="/verify-email">
        {es ? "Enviar o reenviar verificación" : "Send or resend verification"}
      </Link>
    </div>
  );
}
