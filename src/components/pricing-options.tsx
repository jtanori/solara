"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole } from "lucide-react";
import type { BillingCurrency, PriceOption } from "@/lib/billing";
import type { Locale } from "@/lib/i18n";
import { PortalButton } from "@/components/portal-button";

function intervalLabel(price: PriceOption, locale: Locale) {
  const names: Record<string, [string,string]> = { day:["day","día"], week:["week","semana"], month:["month","mes"], year:["year","año"] };
  const unit = names[price.interval]?.[locale === "es" ? 1 : 0] ?? price.interval;
  return price.intervalCount === 1 ? `${locale === "es" ? "/" : "/"} ${unit}` : locale === "es" ? `/ ${price.intervalCount} ${unit}s` : `/ ${price.intervalCount} ${unit}s`;
}
export function PricingOptions({ prices, locale, signedIn, paid, customer }: { prices: PriceOption[]; locale: Locale; signedIn: boolean; paid: boolean; customer: boolean }) {
  const es = locale === "es"; const router = useRouter();
  const [currency, setCurrency] = useState<BillingCurrency>(prices.some(price => price.currency === "mxn") ? "mxn" : prices[0]?.currency ?? "mxn"); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const selected = prices.find(price => price.currency === currency);
  async function checkout() {
    if (!signedIn) { router.push("/account?next=%2Fpricing"); return; }
    setLoading(true); setError("");
    try { const response = await fetch("/api/billing/checkout", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({currency}) }); const data = await response.json(); if (!response.ok || !data.url) { setError(data.error ?? (es ? "No pudimos abrir el pago." : "Could not open checkout.")); setLoading(false); return; } window.location.assign(data.url); } catch { setError(es ? "No pudimos conectar con Stripe." : "Could not connect to Stripe."); setLoading(false); }
  }
  return <div className="pricing-options">{prices.length > 1 && <div className="currency-switch" aria-label={es ? "Moneda" : "Currency"}>{prices.map(price => <button type="button" key={price.currency} className={currency === price.currency ? "selected" : ""} onClick={() => setCurrency(price.currency)}>{price.currency.toUpperCase()}</button>)}</div>}{selected ? <div className="pricing-amount">{new Intl.NumberFormat(es ? "es-MX" : "en-US", {style:"currency",currency:selected.currency.toUpperCase(),maximumFractionDigits:2}).format(selected.amount / 100)} <small>{selected.currency.toUpperCase()} {intervalLabel(selected, locale)}</small></div> : <div className="pricing-amount unavailable">{es ? "Precio no disponible" : "Price unavailable"}</div>}{paid && customer ? <PortalButton locale={locale} /> : <button className="button button-full" type="button" onClick={checkout} disabled={loading || !selected}>{loading ? (es ? "Abriendo Stripe…" : "Opening Stripe…") : (es ? "Elegir Premium" : "Choose Premium")} <ArrowRight size={16} /></button>}{!selected && <p className="field-help">{es ? "Los pagos estarán disponibles cuando se configure Stripe y el precio en MXN." : "Payments will be available once Stripe and an MXN price are configured."}</p>}{error && <div className="error" role="alert" style={{marginTop:10}}>{error}</div>}<div className="pricing-secure"><LockKeyhole size={12} /> {es ? "Pago seguro con Stripe" : "Secure checkout with Stripe"}</div></div>;
}
