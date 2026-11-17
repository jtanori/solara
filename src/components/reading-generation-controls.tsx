"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Locale } from "@/lib/i18n";
import type { ConsentDescriptor } from "@/readings/policy";
import type { GenerationView } from "@/readings/generation-view";
import { pollReadingStatus, publicGenerationView, publicationToRefresh, retryAfterMs, type PollStop } from "@/readings/status-polling";

type ConsentState = { available: boolean; policy: ConsentDescriptor | null; revision: number; active: boolean; hasConsent: boolean };
type Props = { readingId?: string; locale: Locale; initialGeneration?: GenerationView | null; displayedDocumentId?: string | null; allowGeneration?: boolean; refreshOnPublication?: boolean };

/** A keyed session prevents any chart/locale's late mutation response updating another. */
export function ReadingGenerationControls(props: Props) {
  return <GenerationSession key={`${props.readingId ?? "dashboard"}:${props.locale}`} {...props} />;
}
function GenerationSession({ readingId, locale, initialGeneration = null, displayedDocumentId = null, allowGeneration = true, refreshOnPublication = true }: Props) {
  const router = useRouter(); const es = locale === "es";
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [generation, setGeneration] = useState<GenerationView | null>(initialGeneration);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [checking, setChecking] = useState(Boolean(readingId));
  const [stopReason, setStopReason] = useState<PollStop | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [error, setError] = useState("");
  const busyRef = useRef(false); const withdrawingRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const stopPolling = useRef<(() => void) | null>(null);
  const seen = useRef(new Set(displayedDocumentId ? [displayedDocumentId] : []));
  const generationLocale = generation?.locale ?? locale;

  useEffect(() => { if (displayedDocumentId) seen.current.add(displayedDocumentId); }, [displayedDocumentId]);
  const receive = useCallback((view: GenerationView) => {
    setGeneration(view);
    if (refreshOnPublication && publicationToRefresh(view, readingId, seen.current)) router.refresh();
  }, [readingId, refreshOnPublication, router]);
  const checkStatus = useCallback((immediate = true, minimumDelay = 0) => {
    if (!readingId || lifetime.current?.signal.aborted) return;
    stopPolling.current?.();
    setChecking(true); setStopReason(null);
    stopPolling.current = pollReadingStatus({ readingId, immediate, minimumDelay, onView: receive,
      onStop: (reason, nextRetryAt) => { setChecking(false); setStopReason(reason); setRetryAt(nextRetryAt); },
    });
  }, [readingId, receive]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    async function loadConsent() {
      try {
        const response = await fetch("/api/readings/consent", { method: "GET", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        const value: ConsentState = await response.json();
        if (!controller.signal.aborted) setConsent(value);
      } catch { if (!controller.signal.aborted) setError(es ? "No pudimos consultar el consentimiento. Actualiza la página para intentarlo de nuevo." : "We could not load consent. Refresh the page to try again."); }
    }
    void loadConsent();
    if (readingId) stopPolling.current = pollReadingStatus({ readingId, immediate: true, onView: receive,
      onStop: (reason, nextRetryAt) => { if (!controller.signal.aborted) { setChecking(false); setStopReason(reason); setRetryAt(nextRetryAt); } },
    });
    return () => { controller.abort(); stopPolling.current?.(); };
  }, [readingId, es, receive]);

  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(() => setRetryAt(0), Math.min(2_147_483_647, Math.max(0, retryAt - Date.now())));
    return () => clearTimeout(timer);
  }, [retryAt]);

  async function generate() {
    if (!readingId || !allowGeneration || !consent?.policy || !consent.available || busyRef.current || (!consent.active && !accepted)) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    busyRef.current = true; setBusy(true); setError("");
    let nextDelay = 0;
    try {
      if (!consent.active) {
        const grant = await fetch("/api/readings/consent", {
          method: "PUT", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ accepted: true, policyHash: consent.policy.policyHash, expectedRevision: consent.revision }),
        });
        if (!grant.ok) { nextDelay = retryAfterMs(grant.headers.get("retry-after"), Date.now()); throw new Error("consent_changed"); }
        const saved = await grant.json();
        if (controller.signal.aborted) return;
        setConsent({ ...consent, active: true, hasConsent: true, revision: saved.revision });
      }
      const response = await fetch(`/api/readings/${readingId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ locale: generationLocale }),
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        nextDelay = retryAfterMs(response.headers.get("retry-after"), Date.now());
        throw new Error("unavailable");
      }
      const view = publicGenerationView(await response.json());
      if (controller.signal.aborted) return;
      if (!view) throw new Error("unavailable");
      receive(view);
      if (view.status === "in_progress") checkStatus(false, retryAfterMs(response.headers.get("retry-after"), Date.now()));
    } catch {
      if (!controller.signal.aborted) {
        // No lost-response POST/PUT retry. Only a new finite GET session.
        setError(es ? "No pudimos confirmar el resultado. Consultaremos el estado; no se repetirá la generación automáticamente." : "We could not confirm the result. We will check its status; generation will not be retried automatically.");
        if (nextDelay) setRetryAt(Date.now() + nextDelay);
        checkStatus(false, nextDelay);
      }
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) { setBusy(false); setAccepted(false); }
    }
  }
  async function withdraw() {
    if (withdrawingRef.current) return;
    const controller = lifetime.current; if (!controller || controller.signal.aborted) return;
    withdrawingRef.current = true; setWithdrawing(true); setError("");
    try {
      const response = await fetch("/api/readings/consent", { method: "DELETE", signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const saved = await response.json();
      if (!controller.signal.aborted) {
        setConsent(previous => previous ? { ...previous, active: false, hasConsent: false, revision: saved.revision } : previous);
        setAccepted(false);
      }
    } catch { if (!controller.signal.aborted) setError(es ? "No pudimos retirar el consentimiento. Inténtalo de nuevo." : "We could not withdraw consent. Please try again."); }
    finally { withdrawingRef.current = false; if (!controller.signal.aborted) setWithdrawing(false); }
  }

  const shown = Boolean(displayedDocumentId && generation?.documentId === displayedDocumentId);
  const messages: Record<GenerationView["status"], string> = {
    unused: es ? "Tu interpretación gratuita aún no se ha utilizado." : "Your free interpretation has not been used.",
    in_progress: es ? "La solicitud está en curso. Consultaremos su estado durante un tiempo limitado, sin repetirla." : "Your request is in progress. We will check its status for a limited time without repeating it.",
    completed: shown ? (es ? "La interpretación guardada se muestra en esta página." : "The saved interpretation is shown on this page.") : (es ? "El estado indica una interpretación guardada. Consulta la edición guardada para comprobar su disponibilidad." : "The status reports a saved interpretation. Open the saved edition to check its availability."),
    partial: shown ? (es ? "Se muestra la interpretación parcial guardada. No se regenerará automáticamente." : "The saved partial interpretation is shown. It will not regenerate automatically.") : (es ? "El estado indica una interpretación parcial guardada; no se regenerará automáticamente." : "The status reports a saved partial interpretation; it will not regenerate automatically."),
    failed: es ? "La solicitud no produjo una interpretación utilizable. La oferta ya fue utilizada; no se repetirá automáticamente." : "The request did not produce a usable interpretation. The offer has been used and will not retry automatically.",
    indeterminate: es ? "No podemos confirmar el resultado de una solicitud que pudo generar un cargo. No se repetirá automáticamente." : "We cannot confirm the result of a potentially billed request. It will not retry automatically.",
    free_reading_deleted: es ? "La lectura gratuita original fue eliminada. Eliminarla no restablece la oferta." : "The original free reading was deleted. Deleting it does not reset the offer.",
  };
  const unused = generation?.status === "unused" && (!generation.readingId || generation.readingId === readingId);
  return <section className="panel" aria-label={es ? "Consentimiento para IA" : "AI consent"}>
    <h2>{es ? "Tu interpretación con IA" : "Your AI interpretation"}</h2>
    {readingId && <p>{es ? "Una interpretación gratuita por cuenta, en el idioma elegido. Guardar una carta no consume la oferta. La oferta se utiliza al autorizar la primera solicitud al proveedor, incluso si no se obtiene una interpretación utilizable." : "One free interpretation per account, in the chosen language. Saving a chart does not use the offer. The offer is used when the first provider request is authorized, even if no usable interpretation is produced."}</p>}
    {generation && (generation.status !== "unused" || allowGeneration) && <p role="status">{messages[generation.status]}</p>}
    {generation?.locale && <p className="small muted">{es ? "Idioma de la interpretación" : "Interpretation language"}: {generation.locale === "es" ? "Español" : "English"}</p>}
    {generation?.readingId && generation.readingId !== readingId && generation.readingId === initialGeneration?.readingId && <Link className="plain-link" href={`/reading/${generation.readingId}`}>{es ? "Ir a la carta original →" : "Go to the original chart →"}</Link>}
    {!shown && generation?.documentId && generation.readingId === readingId && <p><Link className="plain-link" href={`/reading/${readingId}?document=${generation.documentId}`}>{es ? "Consultar edición guardada" : "Open saved edition"}</Link></p>}
    {readingId && consent && !consent.available && <p className="small muted">{es ? "La generación está deshabilitada o no está disponible. Las lecturas guardadas no requieren generación activa." : "Generation is disabled or unavailable. Saved readings do not require active generation."}</p>}
    {readingId && allowGeneration && unused && consent?.available && consent.policy && <>
      <p>{consent.policy.disclosure}</p>
      <p className="small muted">{es ? "Política" : "Policy"}: {consent.policy.policyVersion} · {generationLocale === "es" ? "Español" : "English"}</p>
      {!consent.active && <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
        <input name="ai-reading-consent" autoComplete="off" type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />
        <span>{es ? `Acepto que ${consent.policy.providerName} procese los datos derivados descritos para generar mi interpretación.` : `I agree to ${consent.policy.providerName} processing the described derived data to generate my interpretation.`}</span>
      </label>}
      <button type="button" className="button" disabled={busy || retryAt > 0 || (!consent.active && !accepted)} onClick={generate}>{busy ? (es ? "Procesando…" : "Processing…") : (es ? "Generar mi interpretación gratuita" : "Generate my free interpretation")}</button>
    </>}
    {readingId && <div style={{ marginTop: 16 }}>
      <button type="button" className="outline-button" disabled={checking || busy || retryAt > 0} onClick={() => checkStatus()}>{checking ? (es ? "Consultando estado…" : "Checking status…") : (es ? "Consultar estado" : "Check status")}</button>
      {stopReason && stopReason !== "terminal" && <p className="small" role="status">{retryAt > 0 ? (es ? "Espera antes de volver a consultar el estado." : "Please wait before checking again.") : (es ? "La consulta automática se detuvo. Puedes consultar el estado de nuevo; esto no vuelve a generar la lectura." : "Automatic status checks stopped. You can check again; this does not regenerate the reading.")}</p>}
    </div>}
    {consent?.hasConsent && <div style={{ marginTop: 16 }}>
      <p className="small muted">{es ? "Retirar el consentimiento impide nuevas solicitudes; una solicitud ya autorizada podría terminar. No elimina las lecturas guardadas ni restablece la oferta." : "Withdrawal prevents new requests; an already authorized request may finish. It does not delete saved readings or reset the offer."}</p>
      <button type="button" className="outline-button" disabled={withdrawing} onClick={withdraw}>{es ? "Retirar consentimiento para IA" : "Withdraw AI consent"}</button>
    </div>}
    {!readingId && consent && !consent.hasConsent && <p>{es ? "No tienes un consentimiento activo para generación con IA." : "You have no active consent for AI generation."}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
