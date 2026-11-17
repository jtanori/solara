import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { isReadingId } from "@/readings/chart-presentation";
import { paidGenerationConfig, paidGenerationEnabled } from "@/readings/paid-policy";
import { PaidReadingStore } from "@/readings/paid-store";
import { log } from "@/lib/log";
import { ArrowLeft, Check, Sparkles } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { PricingOptions } from "@/components/pricing-options";
import { currentUser } from "@/lib/auth";
import { getPriceCatalog } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ billing?: string; reading?: string | string[] }> }) {
  const [user, locale, prices, params] = await Promise.all([currentUser(), getLocale(), getPriceCatalog(), searchParams]);
  const es = locale === "es";
  let readingId: string | undefined;
  let paidAvailable = false;
  let paidSectionCount = 9;
  if (params.reading !== undefined) {
    if (typeof params.reading !== "string" || !isReadingId(params.reading)) notFound();
    if (!user) redirect(`/account?next=${encodeURIComponent(`/pricing?reading=${params.reading}`)}`);
    const [chart] = await db.select({ id: readings.id }).from(readings).where(and(eq(readings.id, params.reading), eq(readings.userId, user.id))).limit(1);
    if (!chart) notFound();
    readingId = chart.id;
    if (paidGenerationEnabled()) {
      try { const offer = await new PaidReadingStore().offer(user.id, chart.id, locale, paidGenerationConfig(), true); paidAvailable = offer.available; paidSectionCount = offer.sections.length; }
      catch { log.warn("readings.paid_offer_unavailable", { userId: user.id }); paidAvailable = false; }
    }
  }
  return <><SiteHeader /><main className="app-page pricing-page"><div className="wrap pricing-wrap"><Link href="/" className="back-link"><ArrowLeft size={15} /> {es ? "Volver al inicio" : "Back to home"}</Link><div className="center-heading pricing-heading"><div className="eyebrow">{es ? "ELIGE TU EXPERIENCIA" : "CHOOSE YOUR EXPERIENCE"}</div><h1>{es ? <>Una mirada a tu año.<br /><em>Tan profunda como quieras.</em></> : <>A little insight for your year.<br /><em>As deep as you like.</em></>}</h1><p>{es ? "Comienza gratis y profundiza cuando quieras." : "Start for free, and go deeper whenever you’re ready."}</p></div>{params.billing === "cancelled" && <div className="notice pricing-notice">{es ? "No se realizó ningún cargo. Puedes volver cuando quieras." : "You weren’t charged. You can come back whenever you’re ready."}</div>}<div className="pricing-grid"><section className="pricing-card"><div className="plan-top"><span>{es ? "UNA PRIMERA MIRADA" : "THE FIRST GLIMPSE"}</span><span>✧</span></div><h2>{es ? "Gratis" : "Free"}</h2><p className="pricing-desc">{es ? "Una puerta de entrada a tu revolución solar." : "A gentle introduction to your solar return."}</p><div className="pricing-amount">$0 <small>MXN</small></div><ul className="pricing-list"><li><Check size={16} /> {es ? "Tu momento exacto de retorno" : "Your solar return moment"}</li><li><Check size={16} /> {es ? "Sol, Luna, ascendente y casa solar" : "Sun, Moon, Ascendant and Sun house"}</li><li><Check size={16} /> {es ? "Carta privada y resumen PDF" : "Private chart and summary PDF"}</li></ul><Link href="/create" className="outline-button plan-button">{es ? "Comenzar gratis" : "Start for free"} →</Link></section><section className="pricing-card premium-card"><div className="plan-top"><span>{es ? "UNA MIRADA MÁS PROFUNDA" : "THE DEEPER DIVE"}</span><span><Sparkles size={18} /></span></div><h2>Solara Premium</h2><p className="pricing-desc">{es ? "Una guía más completa para tu viaje alrededor del Sol." : "A richer guide for your journey around the Sun."}</p><PricingOptions readingId={readingId} prices={prices} locale={locale} signedIn={!!user} paid={user?.plan === "paid"} customer={!!user?.stripeCustomerId} /><ul className="pricing-list">{paidAvailable && <li><Check size={16} /> {es ? `Una edición Placidus de ${paidSectionCount} secciones por mes UTC, mediante solicitud explícita` : `One ${paidSectionCount}-section Placidus edition per UTC month, by explicit request`}</li>}<li><Check size={16} /> {es ? "Todo lo incluido en Gratis" : "Everything in Free"}</li><li><Check size={16} /> {es ? "Notas ilustrativas adicionales sobre tu Luna, ascendente y casa" : "Additional illustrative Moon, Ascendant and house notes"}</li><li><Check size={16} /> {es ? "PDF de tu carta y sus notas ilustrativas" : "A PDF of your chart and illustrative notes"}</li><li><Check size={16} /> {es ? "Administración segura con Stripe" : "Secure subscription management with Stripe"}</li></ul></section></div><div className="pricing-footnote">{readingId && <p><Link className="plain-link" href={`/reading/${readingId}`}>{es ? "Volver a tu carta guardada" : "Return to your saved chart"}</Link></p>}<span>✳</span> {paidAvailable ? (es ? "El pago no solicita una interpretación. Después de la confirmación verificada, vuelve a tu carta para dar consentimiento y solicitarla. Un cupo por mes UTC; no se acumula. Las ediciones guardadas permanecen después de cancelar." : "Checkout does not request an interpretation. After verified confirmation, return to your chart to consent and request it. One allowance per UTC month; no rollover. Saved editions remain after cancellation.") : es ? "Las interpretaciones completas con IA aún no están disponibles; una suscripción no las desbloquea. El precio y la frecuencia dependen de la moneda elegida. Administra o cancela tu suscripción desde tu cuenta." : "Full AI interpretations are not available yet; a subscription does not unlock them. Price and billing frequency are shown for your chosen currency. Manage or cancel your subscription from your account."}</div></div></main><SiteFooter /></>;
}
