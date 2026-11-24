"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Locale } from "@/lib/i18n";
import type { ConsentDescriptor } from "@/readings/policy";
import { ACTIVE_PAID_STATES, PAID_CORE_SECTIONS, type PaidOffer, type PaidRunView } from "@/readings/paid-contract";
import { pollPaidReadingStatus, publicPaidOffer, publicPaidRun } from "@/readings/paid-polling";
import { retryAfterMs, type PollStop } from "@/readings/status-polling";
import { PAID_SECTION_TITLES } from "@/readings/copy";

type Consent = { available: boolean; policy: ConsentDescriptor | null; revision: number; active: boolean };
type Props = { readingId: string; locale: Locale; displayedEditionId?: string | null };
export function PaidReadingControls(props: Props) {
  const [language, setLanguage] = useState(props.locale);
  return <section className="panel" aria-label={props.locale === "es" ? "Ediciones de pago" : "Paid editions"}>
    <h2>{props.locale === "es" ? "Tu interpretación completa · Placidus" : "Your complete interpretation · Placidus"}</h2>
    <label>{props.locale === "es" ? "Idioma de una nueva edición" : "Language for a new edition"}{" "}
      <select name="paid-reading-language" autoComplete="off" aria-label={props.locale === "es" ? "Idioma de una nueva edición" : "Language for a new edition"} value={language} onChange={event => setLanguage(event.target.value as Locale)}>
        <option value="en">English</option><option value="es">Español</option>
      </select>
    </label>
    <PaidSession key={`${props.readingId}:${language}`} {...props} language={language} />
  </section>;
}
function PaidSession({ readingId, locale, language, displayedEditionId }: Props & { language: Locale }) {
  const es = locale === "es";
  const [offer, setOffer] = useState<PaidOffer | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [stopReason, setStopReason] = useState<PollStop | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<PaidOffer | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const stopPolling = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);
  const receive = useCallback((value: PaidOffer) => { setOffer(value); }, []);
  const check = useCallback((immediate = true, minimumDelay = 0) => {
    if (!lifetime.current || lifetime.current.signal.aborted) return;
    stopPolling.current?.(); setChecking(true); setStopReason(null);
    stopPolling.current = pollPaidReadingStatus({ readingId, locale: language, immediate, minimumDelay, onView: receive,
      onStop: (reason, nextRetry) => { setChecking(false); setStopReason(reason); setRetryAt(nextRetry); } });
  }, [readingId, language, receive]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void (async () => {
      try {
        const response = await fetch("/api/readings/consent", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("unavailable");
        const value: Consent = await response.json();
        if (!controller.signal.aborted) setConsent(value);
      } catch { if (!controller.signal.aborted) setError(es ? "No pudimos consultar el consentimiento." : "We could not load consent."); }
    })();
    stopPolling.current = pollPaidReadingStatus({ readingId, locale: language, immediate: true, onView: receive,
      onStop: (reason, nextRetry) => { if (!controller.signal.aborted) { setChecking(false); setStopReason(reason); setRetryAt(nextRetry); } } });
    return () => { controller.abort(); stopPolling.current?.(); };
  }, [readingId, language, es, receive]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(() => setRetryAt(0), Math.min(2_147_483_647, Math.max(0, retryAt - Date.now())));
    return () => clearTimeout(timer);
  }, [retryAt]);

  const canRequest = Boolean(offer?.available && offer.entitled && offer.allowance === "available" && offer.offerHash && !offer.runs.some(run => ACTIVE_PAID_STATES.includes(run.status)));
  async function generate() {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busyRef.current || !canRequest || !offer?.offerHash || !consent?.policy || !confirmed || (!consent.active && !accepted)) return;
    busyRef.current = true; setBusy(true); setError("");
    let minimumDelay = 0;
    try {
      if (!consent.active) {
        const grant = await fetch("/api/readings/consent", { method: "PUT", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ accepted: true, policyHash: consent.policy.policyHash, expectedRevision: consent.revision }) });
        if (!grant.ok) { minimumDelay = retryAfterMs(grant.headers.get("retry-after"), Date.now()); throw new Error("consent_changed"); }
        const saved = await grant.json();
        if (controller.signal.aborted) return;
        setConsent({ ...consent, active: true, revision: saved.revision });
      }
      // One explicit intent. A lost response is followed only by GET checks.
      const response = await fetch(`/api/readings/${readingId}/paid`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ requestId: crypto.randomUUID(), locale: language, profile: offer.profile, period: offer.period, offerHash: offer.offerHash }) });
      if (!response.ok) { minimumDelay = retryAfterMs(response.headers.get("retry-after"), Date.now()); throw new Error("unavailable"); }
      const saved = publicPaidRun(await response.json());
      if (!saved) throw new Error("invalid_response");
      if (!controller.signal.aborted) setOffer(previous => previous ? { ...previous, allowance: saved.allowanceConsumed ? "consumed" : "reserved", runs: [saved, ...previous.runs.filter(run => run.id !== saved.id)].slice(0, 20) } : previous);
    } catch {
      if (!controller.signal.aborted) setError(es ? "No pudimos confirmar la solicitud. Consultaremos el estado; no se enviará de nuevo automáticamente." : "We could not confirm the request. We will check its status; it will not be sent again automatically.");
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) { setBusy(false); setAccepted(false); setConfirmed(false); check(false, minimumDelay); }
    }
  }
  async function stop(run: PaidRunView) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/readings/${readingId}/paid/${run.id}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: "{}" });
      if (!response.ok) throw new Error("unavailable");
    } catch { if (!controller.signal.aborted) setError(es ? "No pudimos confirmar la detención. Consulta el estado antes de intentarlo de nuevo." : "We could not confirm the stop. Check status before trying again."); }
    finally { busyRef.current = false; if (!controller.signal.aborted) { setBusy(false); check(); } }
  }
  async function older() {
    const cursor = (history ?? offer)?.nextCursor; const controller = lifetime.current;
    if (!cursor || !controller || controller.signal.aborted || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/readings/${readingId}/paid?locale=${language}&cursor=${cursor}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const page = publicPaidOffer(await response.json()); if (!page) throw new Error("invalid_response");
      if (!controller.signal.aborted) setHistory(page);
    } catch { if (!controller.signal.aborted) setError(es ? "No pudimos consultar las ediciones anteriores." : "We could not load earlier editions."); }
    finally { busyRef.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  function status(run: PaidRunView) {
    const copy: Record<PaidRunView["status"], string> = {
      queued: es ? "En cola" : "Queued", preparing: es ? "Preparando la carta" : "Preparing the chart", generating: es ? "Generando" : "Generating",
      completed: es ? "Completa" : "Complete", partial: es ? "Parcial; no se regenerará automáticamente" : "Partial; will not regenerate automatically",
      failed: run.reason === "placidus_unavailable" ? (es ? "Placidus no está disponible para esta carta; no se utilizó el cupo" : "Placidus is unavailable for this chart; allowance was not used") : (es ? "No se produjo una edición utilizable" : "No usable edition was produced"),
      stopped: es ? "Detenida; no se autorizarán más solicitudes" : "Stopped; no more requests will be authorized",
      attention: es ? "Requiere atención: el gasto no está confirmado o excedió un límite; no se reintentará" : "Needs attention: spend is uncertain or exceeded a bound; will not retry",
    };
    return copy[run.status];
  }
  return <>
    <p>{es ? `${offer?.sections.length ?? 9} secciones basadas en una carta Placidus. No necesitas utilizar primero la oferta gratuita. Guardar una carta no solicita una interpretación.` : `${offer?.sections.length ?? 9} sections grounded in a Placidus chart. You do not need to use the free offer first. Saving a chart does not request an interpretation.`}</p>
    <details><summary>{es ? "Contenido de esta edición" : "What this edition contains"}</summary><ul>{(offer?.sections ?? PAID_CORE_SECTIONS).map(key => <li key={key}>{PAID_SECTION_TITLES[key][locale]}</li>)}</ul></details>
    <p className="small muted">{es ? "Un cupo por cuenta y mes calendario UTC, sin acumulación. Se utiliza al autorizar la primera solicitud al proveedor, incluso si falla. Cambiar de idioma o pedir una actualización requiere otra solicitud y otro cupo. Las ediciones guardadas permanecen disponibles después de cancelar la suscripción." : "One allowance per account per UTC calendar month, with no rollover. It is used when the first provider request is authorized, even if it fails. Another language or refresh requires a new request and allowance. Saved editions remain available after subscription cancellation."}</p>
    {offer && <p role="status">{es ? "Cupo" : "Allowance"} · {offer.period}: {({ available: es ? "disponible" : "available", reserved: es ? "reservado" : "reserved", consumed: es ? "utilizado" : "used", attention: es ? "bloqueado hasta revisar el gasto" : "blocked pending spend review" })[offer.allowance]}</p>}
    {offer && !offer.available && <p className="notice">{es ? "La generación de pago aún no está disponible. Puedes abrir las ediciones que ya estén guardadas." : "Paid generation is not currently available. You can still open previously saved editions."}</p>}
    {offer?.available && !offer.entitled && <p>{es ? "Se necesita una suscripción verificada antes de solicitar una edición. El pago no inicia generación automáticamente." : "A verified subscription is required before requesting an edition. Checkout does not start generation automatically."} <Link className="plain-link" href={`/pricing?reading=${readingId}`}>{es ? "Ver Premium" : "View Premium"}</Link></p>}
    {canRequest && consent?.policy && <>
      <p>{consent.policy.disclosure}</p>
      {!consent.active && <label style={{ display: "flex", gap: 10, marginBottom: 12 }}><input type="checkbox" name="paid-ai-consent" autoComplete="off" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} /><span>{es ? `Acepto el procesamiento descrito por ${consent.policy.providerName}.` : `I agree to the described processing by ${consent.policy.providerName}.`}</span></label>}
      <label style={{ display: "flex", gap: 10, marginBottom: 16 }}><input type="checkbox" name="paid-allowance-confirmation" autoComplete="off" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>{es ? `Solicito esta nueva edición en ${language === "es" ? "español" : "inglés"} usando mi cupo de ${offer?.period}.` : `I request this new ${language === "es" ? "Spanish" : "English"} edition using my ${offer?.period} allowance.`}</span></label>
      <button className="button" type="button" disabled={busy || retryAt > 0 || !confirmed || (!consent.active && !accepted)} onClick={generate}>{busy ? (es ? "Enviando solicitud…" : "Submitting request…") : (es ? "Solicitar mi edición de pago" : "Request my paid edition")}</button>
    </>}
    <p className="small muted">{es ? "Puedes cerrar esta página después de solicitarla. El trabajo aceptado continúa. Detener bloquea nuevas solicitudes; una ya autorizada puede terminar y consumir el cupo." : "You can close this page after requesting it. Accepted work continues. Stop blocks new requests; an already authorized request may finish and consume the allowance."}</p>
    {(history ?? offer)?.runs.map(run => <div key={run.id} style={{ borderTop: "1px solid #e4d9cf", padding: "14px 0" }}>
      <p><strong>{status(run)}</strong> · {run.locale === "es" ? "Español" : "English"} · {run.period}<br />{run.completedSections}/{run.totalSections} {es ? "secciones validadas" : "validated sections"}</p>
      <p className="small muted">{run.allowanceConsumed ? (es ? "Cupo utilizado. No hay reposición automática." : "Allowance used. No automatic replacement.") : ACTIVE_PAID_STATES.includes(run.status) ? (es ? "Cupo reservado; aún no utilizado." : "Allowance reserved; not yet used.") : (es ? "No se utilizó el cupo." : "Allowance was not used.")}</p>
      {run.editionId && (displayedEditionId === run.editionId ? <p>{es ? "Esta edición se muestra abajo." : "This edition is shown below."}</p> : <Link className="plain-link" href={`/reading/${readingId}?paidEdition=${run.editionId}`}>{es ? "Abrir esta edición guardada" : "Open this saved edition"}</Link>)}
      {ACTIVE_PAID_STATES.includes(run.status) && <button className="outline-button" type="button" disabled={busy} onClick={() => stop(run)}>{es ? "Detener solicitud" : "Stop request"}</button>}
    </div>)}
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
      <button className="outline-button" type="button" disabled={busy || checking || retryAt > 0} onClick={() => check()}>{checking ? (es ? "Consultando…" : "Checking…") : (es ? "Consultar estado" : "Check status")}</button>
      {(history ?? offer)?.nextCursor && <button className="outline-button" type="button" disabled={busy} onClick={older}>{es ? "Solicitudes anteriores" : "Earlier requests"}</button>}
      {history && <button className="outline-button" type="button" onClick={() => setHistory(null)}>{es ? "Volver a recientes" : "Back to recent"}</button>}
    </div>
    {stopReason && stopReason !== "terminal" && <p className="small" role="status">{es ? "La consulta automática se detuvo; el trabajo aceptado no se cancela. Puedes consultar el estado de nuevo, sin generar otra edición." : "Automatic status checks stopped; accepted work is not cancelled. You can check again without generating another edition."}</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
