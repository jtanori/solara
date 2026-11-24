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

export function accountClaimMessage(input: {
  to: string;
  name: string;
  url: string;
  locale: "en" | "es";
}): MailMessage {
  if (input.locale === "es") {
    const subject = "Reclama tu cuenta de Solara";
    const text = [
      `Hola ${input.name},`,
      "",
      "Alguien solicitó una cuenta con este correo. Si fuiste tú, abre el enlace y elige tu contraseña:",
      "",
      input.url,
      "",
      "El enlace caduca en 24 horas y solo puede usarse una vez.",
      "Si no solicitaste esta cuenta, ignora este mensaje. Nadie podrá entrar sin este enlace.",
    ].join("\n");
    const html = `<p>Hola ${escapeHtml(input.name)},</p><p>Alguien solicitó una cuenta con este correo. Si fuiste tú, abre el enlace y elige tu contraseña:</p><p><a href="${escapeHtml(input.url)}">Reclamar mi cuenta</a></p><p>El enlace caduca en 24 horas y solo puede usarse una vez.</p><p>Si no solicitaste esta cuenta, ignora este mensaje. Nadie podrá entrar sin este enlace.</p>`;
    return { to: input.to, subject, text, html };
  }

  const subject = "Claim your Solara account";
  const text = [
    `Hi ${input.name},`,
    "",
    "Someone requested an account with this email. If that was you, open the link and choose your password:",
    "",
    input.url,
    "",
    "This link expires in 24 hours and can only be used once.",
    "If you did not request this account, ignore this message. Nobody can sign in without this link.",
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(input.name)},</p><p>Someone requested an account with this email. If that was you, open the link and choose your password:</p><p><a href="${escapeHtml(input.url)}">Claim my account</a></p><p>This link expires in 24 hours and can only be used once.</p><p>If you did not request this account, ignore this message. Nobody can sign in without this link.</p>`;
  return { to: input.to, subject, text, html };
}

export function accountExistsMessage(input: {
  to: string;
  name: string;
  url: string;
  locale: "en" | "es";
}): MailMessage {
  if (input.locale === "es") {
    const subject = "Tu cuenta de Solara ya existe";
    const text = [
      `Hola ${input.name},`,
      "",
      "Alguien intentó crear una cuenta con este correo, pero ya existe una cuenta verificada.",
      "",
      input.url,
      "",
      "Si fuiste tú, inicia sesión. Si no, puedes ignorar este mensaje.",
    ].join("\n");
    const html = `<p>Hola ${escapeHtml(input.name)},</p><p>Alguien intentó crear una cuenta con este correo, pero ya existe una cuenta verificada.</p><p><a href="${escapeHtml(input.url)}">Iniciar sesión</a></p><p>Si no fuiste tú, puedes ignorar este mensaje.</p>`;
    return { to: input.to, subject, text, html };
  }

  const subject = "Your Solara account already exists";
  const text = [
    `Hi ${input.name},`,
    "",
    "Someone tried to create an account with this email, but a verified account already exists.",
    "",
    input.url,
    "",
    "If that was you, sign in. Otherwise, you can ignore this message.",
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(input.name)},</p><p>Someone tried to create an account with this email, but a verified account already exists.</p><p><a href="${escapeHtml(input.url)}">Sign in</a></p><p>If that was not you, you can ignore this message.</p>`;
  return { to: input.to, subject, text, html };
}

export function passwordResetMessage(input: {
  to: string;
  name: string;
  url: string;
  locale: "en" | "es";
}): MailMessage {
  if (input.locale === "es") {
    const subject = "Restablece tu contraseña de Solara";
    const text = [
      `Hola ${input.name},`,
      "",
      "Alguien solicitó restablecer la contraseña de tu cuenta. Si fuiste tú, abre el enlace y elige una nueva contraseña:",
      "",
      input.url,
      "",
      "El enlace caduca en 1 hora y solo puede usarse una vez.",
      "Si no lo solicitaste, ignora este mensaje; tu contraseña actual sigue funcionando.",
    ].join("\n");
    const html = `<p>Hola ${escapeHtml(input.name)},</p><p>Alguien solicitó restablecer la contraseña de tu cuenta. Si fuiste tú, abre el enlace y elige una nueva contraseña:</p><p><a href="${escapeHtml(input.url)}">Restablecer mi contraseña</a></p><p>El enlace caduca en 1 hora y solo puede usarse una vez.</p><p>Si no lo solicitaste, ignora este mensaje; tu contraseña actual sigue funcionando.</p>`;
    return { to: input.to, subject, text, html };
  }

  const subject = "Reset your Solara password";
  const text = [
    `Hi ${input.name},`,
    "",
    "Someone requested a password reset for your account. If that was you, open the link and choose a new password:",
    "",
    input.url,
    "",
    "This link expires in 1 hour and can only be used once.",
    "If you did not request it, ignore this message; your current password still works.",
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(input.name)},</p><p>Someone requested a password reset for your account. If that was you, open the link and choose a new password:</p><p><a href="${escapeHtml(input.url)}">Reset my password</a></p><p>This link expires in 1 hour and can only be used once.</p><p>If you did not request it, ignore this message; your current password still works.</p>`;
  return { to: input.to, subject, text, html };
}
