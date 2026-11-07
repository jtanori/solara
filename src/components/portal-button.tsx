"use client";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Locale } from "@/lib/i18n";

export function PortalButton({ locale }: { locale: Locale }) {
  const es = locale === "es"; const [loading,setLoading] = useState(false); const [error,setError] = useState("");
  async function open() {
    setLoading(true); setError("");
    try { const response = await fetch("/api/billing/portal", {method:"POST"}); const data = await response.json(); if (!response.ok || !data.url) { setError(data.error ?? (es ? "No pudimos abrir el portal." : "Could not open the portal.")); setLoading(false); return; } window.location.assign(data.url); } catch { setError(es ? "No pudimos conectar con Stripe." : "Could not connect to Stripe."); setLoading(false); }
  }
  return <div><button type="button" className="outline-button plan-button" onClick={open} disabled={loading}>{loading ? (es ? "Abriendo…" : "Opening…") : (es ? "Gestionar suscripción" : "Manage subscription")} <ArrowUpRight size={15} /></button>{error && <div className="error" style={{marginTop:10}} role="alert">{error}</div>}</div>;
}
