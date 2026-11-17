import type { GenerationView } from "@/readings/generation-view";

export const STATUS_POLL_LIMITS = { durationMs: 60_000, requests: 20, requestMs: 8_000, delays: [3_000, 6_000, 10_000] } as const;
export type PollStop = "terminal" | "budget" | "hidden" | "error" | "unauthorized" | "rate_limited";
const statuses = new Set(["unused", "in_progress", "completed", "partial", "failed", "indeterminate", "free_reading_deleted"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function publicGenerationView(value: unknown): GenerationView | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.status !== "string" || !statuses.has(v.status) ||
    !(v.locale === null || v.locale === "en" || v.locale === "es") ||
    ![v.readingId, v.documentId].every(id => id === null || typeof id === "string" && uuid.test(id))) return null;
  return { status: v.status as GenerationView["status"], readingId: v.readingId as string | null, documentId: v.documentId as string | null, locale: v.locale };
}
export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export type StatusPollEnvironment = {
  fetch: typeof fetch; now: () => number;
  later: (action: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
  hidden: () => boolean;
  onHidden: (action: () => void) => () => void;
};
const browserEnvironment = (): StatusPollEnvironment => ({
  fetch: (...args) => fetch(...args), now: Date.now,
  // Native Window timers require their Window receiver (fake clocks do not).
  later: (action, ms) => setTimeout(action, ms), cancel: timer => clearTimeout(timer),
  hidden: () => document.visibilityState === "hidden",
  onHidden: action => { document.addEventListener("visibilitychange", action); return () => document.removeEventListener("visibilitychange", action); },
});

/** GET-only finite session. Hidden/offline/terminal states require an explicit
 * new status check. It has no generation/consent endpoint or mutation callback. */
export function pollReadingStatus(options: {
  readingId: string; immediate?: boolean; minimumDelay?: number;
  onView: (view: GenerationView) => void;
  onStop: (reason: PollStop, retryAt: number) => void;
}, environment?: StatusPollEnvironment): () => void {
  const env = environment ?? browserEnvironment();
  const start = env.now(); let count = 0; let stopped = false;
  let retryAt = options.minimumDelay ? start + options.minimumDelay : 0;
  let next: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let unsubscribe = () => {};
  const cleanup = () => {
    stopped = true;
    if (next !== undefined) env.cancel(next);
    if (requestTimer !== undefined) env.cancel(requestTimer);
    controller?.abort(); unsubscribe();
  };
  const stop = (reason: PollStop) => { if (!stopped) { cleanup(); options.onStop(reason, retryAt); } };
  const schedule = (delay: number) => {
    if (stopped) return;
    if (count >= STATUS_POLL_LIMITS.requests || env.now() + delay - start >= STATUS_POLL_LIMITS.durationMs) { stop(retryAt > env.now() ? "rate_limited" : "budget"); return; }
    next = env.later(() => { void tick(); }, delay);
  };
  const tick = async () => {
    if (stopped) return;
    if (env.hidden()) return stop("hidden");
    if (env.now() - start >= STATUS_POLL_LIMITS.durationMs || count >= STATUS_POLL_LIMITS.requests) return stop("budget");
    count++;
    controller = new AbortController();
    requestTimer = env.later(() => { stop("error"); }, Math.min(STATUS_POLL_LIMITS.requestMs, STATUS_POLL_LIMITS.durationMs - (env.now() - start)));
    try {
      const response = await env.fetch(`/api/readings/${options.readingId}/generation`, { method: "GET", cache: "no-store", signal: controller.signal });
      if (stopped) return;
      const delay = Math.max(STATUS_POLL_LIMITS.delays[Math.min(count - 1, 2)], retryAfterMs(response.headers.get("retry-after"), env.now()));
      if (response.status === 429) { retryAt = env.now() + delay; schedule(delay); return; }
      if (response.status === 401 || response.status === 404) return stop("unauthorized");
      if (!response.ok) return stop("error");
      const view = publicGenerationView(await response.json());
      if (stopped) return;
      if (!view) return stop("error");
      options.onView(view);
      if (view.status !== "in_progress") return stop("terminal");
      schedule(delay);
    } catch { if (!stopped) stop("error"); }
    finally { if (requestTimer !== undefined) env.cancel(requestTimer); }
  };
  unsubscribe = env.onHidden(() => { if (env.hidden()) stop("hidden"); });
  if (env.hidden()) stop("hidden");
  else schedule(Math.max(options.minimumDelay ?? 0, options.immediate ? 0 : STATUS_POLL_LIMITS.delays[0]));
  return cleanup;
}

/** Per-mounted-chart guard, including a failed projection after refresh. */
export function publicationToRefresh(view: GenerationView, readingId: string | undefined, seen: Set<string>): string | null {
  if (!readingId || view.readingId !== readingId || !view.documentId || !["completed", "partial"].includes(view.status) || seen.has(view.documentId)) return null;
  seen.add(view.documentId);
  return view.documentId;
}
