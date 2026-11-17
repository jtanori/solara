"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Locale } from "@/lib/i18n";
import type { ConsentDescriptor } from "@/readings/policy";
import type { GenerationView } from "@/readings/generation-store";

type ConsentState = { available: boolean; policy: ConsentDescriptor | null; revision: number; active: boolean; hasConsent: boolean };

/** Minimal opt-in/status surface. The existing chart notes are NOT labelled AI output. */
export function ReadingGenerationControls({ readingId, locale }: { readingId?: string; locale: Locale }) {
  const es = locale === "es";
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [generation, setGeneration] = useState<GenerationView | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const generationLocale = generation?.locale ?? locale;
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/readings/consent", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        setConsent(await response.json());
        if (readingId) {
          const status = await fetch(`/api/readings/${readingId}/generation`, { cache: "no-store", signal: controller.signal });
          if (!status.ok) throw new Error("unavailable");
          setGeneration(await status.json());
        }
      } catch { if (!controller.signal.aborted) setError(es ? "No pudimos consultar el estado. Actualiza la página para intentarlo de nuevo." : "We could not load the status. Refresh the page to try again."); }
    }
    void load();
    return () => controller.abort();
  }, [readingId, es]);

  async function generate() {
    if (!readingId || !consent?.policy || !consent.available || busy || (!consent.active && !accepted)) return;
    setBusy(true); setError("");
    try {
      if (!consent.active) {
        const grant = await fetch("/api/readings/consent", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accepted: true, policyHash: consent.policy.policyHash, expectedRevision: consent.revision }),
        });
        if (!grant.ok) throw new Error("consent_changed");
        const saved = await grant.json();
        setConsent({ ...consent, active: true, hasConsent: true, revision: saved.revision });
      }
      const response = await fetch(`/api/readings/${readingId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: generationLocale }),
      });
      if (!response.ok) throw new Error("unavailable");
      setGeneration(await response.json());
    } catch {
      // Do not retry generation after a lost response: GET status is read-only.
      setError(es ? "No pudimos confirmar el resultado. Actualiza la página para consultar el estado; no se repetirá la generación automáticamente." : "We could not confirm the result. Refresh to check its status; generation will not be retried automatically.");
    } finally { setBusy(false); setAccepted(false); }
  }

  async function withdraw() {
    setWithdrawing(true); setError("");
    try {
      const response = await fetch("/api/readings/consent", { method: "DELETE" });
      if (!response.ok) throw new Error("unavailable");
      const saved = await response.json();
      setConsent(previous => previous ? { ...previous, active: false, hasConsent: false, revision: saved.revision } : previous);
      setAccepted(false);
    } catch { setError(es ? "No pudimos retirar el consentimiento. Inténtalo de nuevo." : "We could not withdraw consent. Please try again."); }
    finally { setWithdrawing(false); }
  }

  const messages: Record<GenerationView["status"], string> = {
    unused: es ? "Tu interpretación gratuita aún no se ha utilizado." : "Your free interpretation has not been used.",
    in_progress: es ? "La solicitud está en curso. Actualiza para consultar su estado, sin repetirla." : "Your request is in progress. Refresh to check its status without repeating it.",
    completed: es ? "La interpretación quedó guardada. La presentación del documento generado aún no está disponible aquí; las notas de abajo son las notas ilustrativas de la carta." : "The interpretation is saved. Generated-document presentation is not available here yet; the notes below remain the chart’s illustrative notes.",
    partial: es ? "Se guardó una interpretación parcial; no se regenerará automáticamente. La presentación del documento generado aún no está disponible aquí." : "A partial interpretation was saved; it will not regenerate automatically. Generated-document presentation is not available here yet.",
    failed: es ? "La solicitud no produjo una interpretación utilizable. La oferta ya fue utilizada; no se repetirá automáticamente." : "The request did not produce a usable interpretation. The offer has been used and will not retry automatically.",
    indeterminate: es ? "No podemos confirmar el resultado de una solicitud que pudo generar un cargo. No se repetirá automáticamente." : "We cannot confirm the result of a potentially billed request. It will not retry automatically.",
    free_reading_deleted: es ? "La lectura gratuita original fue eliminada. Eliminarla no restablece la oferta." : "The original free reading was deleted. Deleting it does not reset the offer.",
  };
  const unused = generation?.status === "unused" && (!generation.readingId || generation.readingId === readingId);
  return <section className="panel" aria-label={es ? "Consentimiento para IA" : "AI consent"}>
    <h2>{es ? "Tu interpretación con IA" : "Your AI interpretation"}</h2>
    {readingId && <p>{es ? "Una interpretación gratuita por cuenta, en el idioma elegido. Guardar una carta no consume la oferta. La oferta se utiliza al autorizar la primera solicitud al proveedor, incluso si no se obtiene una interpretación utilizable." : "One free interpretation per account, in the chosen language. Saving a chart does not use the offer. The offer is used when the first provider request is authorized, even if no usable interpretation is produced."}</p>}
    {generation && <p role="status">{messages[generation.status]}</p>}
    {generation?.locale && <p className="small muted">{es ? "Idioma de la interpretación" : "Interpretation language"}: {generation.locale === "es" ? "Español" : "English"}</p>}
    {generation?.readingId && generation.readingId !== readingId && <Link className="plain-link" href={`/reading/${generation.readingId}`}>{es ? "Ir a la carta original →" : "Go to the original chart →"}</Link>}
    {readingId && consent && !consent.available && <p className="small muted">{es ? "La generación está deshabilitada o no está disponible. Tu carta y PDF siguen disponibles." : "Generation is disabled or unavailable. Your chart and PDF remain available."}</p>}
    {readingId && unused && consent?.available && consent.policy && <>
      <p>{consent.policy.disclosure}</p>
      <p className="small muted">{es ? "Política" : "Policy"}: {consent.policy.policyVersion} · {generationLocale === "es" ? "Español" : "English"}</p>
      {!consent.active && <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
        <input name="ai-reading-consent" autoComplete="off" type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />
        <span>{es ? `Acepto que ${consent.policy.providerName} procese los datos derivados descritos para generar mi interpretación.` : `I agree to ${consent.policy.providerName} processing the described derived data to generate my interpretation.`}</span>
      </label>}
      <button type="button" className="button" disabled={busy || (!consent.active && !accepted)} onClick={generate}>{busy ? (es ? "Procesando…" : "Processing…") : (es ? "Generar mi interpretación gratuita" : "Generate my free interpretation")}</button>
    </>}
    {consent?.hasConsent && <div style={{ marginTop: 16 }}>
      <p className="small muted">{es ? "Retirar el consentimiento impide nuevas solicitudes; una solicitud ya autorizada podría terminar. No elimina las lecturas guardadas ni restablece la oferta." : "Withdrawal prevents new requests; an already authorized request may finish. It does not delete saved readings or reset the offer."}</p>
      <button type="button" className="outline-button" disabled={withdrawing} onClick={withdraw}>{es ? "Retirar consentimiento para IA" : "Withdraw AI consent"}</button>
    </div>}
    {!readingId && consent && !consent.hasConsent && <p>{es ? "No tienes un consentimiento activo para generación con IA." : "You have no active consent for AI generation."}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
