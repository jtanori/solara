import type { MailMessage } from "@/lib/mail";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}

export function emailVerificationMessage(input: {
  to: string;
  name: string;
  url: string;
  locale: "en" | "es";
}): MailMessage {
  if (input.locale === "es") {
    const subject = "Verifica tu correo de Solara";
    const text = [
      `Hola ${input.name},`,
      "",
      "Confirma tu correo para proteger tu cuenta y habilitar el pago y la eliminación de cuenta.",
      "",
      input.url,
      "",
      "El enlace caduca en 24 horas y solo puede usarse una vez.",
      "Si no creaste esta cuenta, puedes ignorar este mensaje.",
    ].join("\n");
    const html = `<p>Hola ${escapeHtml(input.name)},</p><p>Confirma tu correo para proteger tu cuenta y habilitar el pago y la eliminación de cuenta.</p><p><a href="${escapeHtml(input.url)}">Verificar mi correo</a></p><p>El enlace caduca en 24 horas y solo puede usarse una vez.</p><p>Si no creaste esta cuenta, puedes ignorar este mensaje.</p>`;
    return { to: input.to, subject, text, html };
  }

  const subject = "Verify your Solara email";
  const text = [
    `Hi ${input.name},`,
    "",
    "Confirm your email to protect your account and enable checkout and account deletion.",
    "",
    input.url,
    "",
    "This link expires in 24 hours and can only be used once.",
    "If you did not create this account, you can ignore this message.",
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(input.name)},</p><p>Confirm your email to protect your account and enable checkout and account deletion.</p><p><a href="${escapeHtml(input.url)}">Verify my email</a></p><p>This link expires in 24 hours and can only be used once.</p><p>If you did not create this account, you can ignore this message.</p>`;
  return { to: input.to, subject, text, html };
}
