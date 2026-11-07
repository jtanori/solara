"use client";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import type { Locale } from "@/lib/i18n";

export function LanguageSwitcher({ locale }: { locale: Locale }) {
  const router = useRouter();
  function change(value: string) {
    if (value !== "en" && value !== "es") return;
    document.cookie = `solara_locale=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.refresh();
  }
  return <div className="language-switch"><Globe size={16} /><select name="language" autoComplete="off" aria-label={locale === "es" ? "Idioma" : "Language"} value={locale} onChange={event => change(event.target.value)}><option value="en">EN</option><option value="es">ES</option></select></div>;
}
