"use client";

import { useEffect, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

type Phase = "checking" | "running" | "sending" | "unknown" | "stopped" |
  "hidden" | "unavailable";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Analysis starts, and later invocations follow, while the page is open.
 * One visible tab polls at most 2,880 times a day, inside the route's
 * 5,000-read daily limit; a hidden tab does not poll. */
const REFRESH_MS = 30_000;
/** Used when a rate-limit response carries no usable Retry-After. */
const RATE_LIMIT_PAUSE_MS = 5 * 60_000;
const REFRESHED_PHASES: ReadonlySet<Phase> = new Set(["hidden", "running",
  "stopped", "unavailable"]);

function duration(startedAt: string | null, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start) || now === 0) return "—";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60,
    seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

/** docs/policy/amux-intake.md v19 item 3: start time, elapsed time and one
 * confirmed stop for the in-flight v19 session analysis. There is no time
 * limit; this button is the stop. The state is re-read while the page is open,
 * so a run that starts later, or the next invocation of the same idea, can be
 * stopped without reloading. A lost POST response makes that claim read-back
 * only, including after a reload: a missing receipt never enables another
 * POST for the same claim. */
export function AmuxSessionAnalysisStopPanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages).sessionStop;
  const [phase, setPhase] = useState<Phase>("checking");
  const [claimId, setClaimId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [refused, setRefused] = useState(false);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const inFlight = useRef(false);
  const pausedUntil = useRef(0);
  const storageKey = `amux-v19-session-analysis-stop:${ideaId}`;

  const readBack = async (automatic = false) => {
    if (inFlight.current) return;
    if (automatic && (document.visibilityState !== "visible" ||
        Date.now() < pausedUntil.current)) return;
    let pending: string | null;
    try { pending = window.sessionStorage.getItem(storageKey); }
    catch { setPhase("unavailable"); return; }
    inFlight.current = true;
    try {
      const response = await adminFetch(
        `/api/admin/amux/ideas/session-analysis-stop?${new URLSearchParams({ ideaId })}`,
        { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      const row = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown> : null;
      if (response.status === 429) {
        const seconds = Number(response.headers.get("Retry-After"));
        pausedUntil.current = Date.now() + (Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds * 1000, 24 * 60 * 60_000) : RATE_LIMIT_PAUSE_MS);
        setPhase(pending ? "unknown" : "unavailable");
      } else if (response.status === 428) {
        setNeedsReauthentication(true);
        setPhase(pending ? "unknown" : "unavailable");
      } else if (response.ok && row?.state === "stopped" && row.ideaId === ideaId &&
          typeof row.claimId === "string" && UUID.test(row.claimId)) {
        window.sessionStorage.removeItem(storageKey);
        setClaimId(row.claimId);
        setPhase("stopped");
      } else if (response.ok && row?.state === "running" && row.ideaId === ideaId &&
          typeof row.claimId === "string" && UUID.test(row.claimId) &&
          typeof row.startedAt === "string") {
        if (pending === row.claimId) {
          // An unresolved stop for this exact claim stays read-back only.
          setPhase("unknown");
        } else {
          // A different claim is running: the stored stop no longer names it.
          if (pending !== null) window.sessionStorage.removeItem(storageKey);
          setClaimId(row.claimId);
          setStartedAt(row.startedAt);
          setPhase("running");
        }
      } else if (response.ok && row?.state === "not_visible") {
        setPhase(pending ? "unknown" : "hidden");
      } else {
        setPhase(pending ? "unknown" : "unavailable");
      }
    } catch { setPhase(pending ? "unknown" : "unavailable"); }
    finally { inFlight.current = false; }
  };

  useEffect(() => {
    queueMicrotask(() => { void readBack(); });
    // The opened idea has a stable key; switching ideas remounts this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaId]);

  useEffect(() => {
    if (!REFRESHED_PHASES.has(phase)) return;
    const timer = window.setInterval(() => { void readBack(true); }, REFRESH_MS);
    const shown = () => { void readBack(true); };
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
    // readBack reads only refs, storage and props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ideaId]);

  useEffect(() => {
    if (phase !== "running") return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const stop = async () => {
    if (phase !== "running" || !claimId || inFlight.current ||
        !window.confirm(m.confirm)) return;
    try { window.sessionStorage.setItem(storageKey, claimId); }
    catch { setPhase("unavailable"); return; }
    inFlight.current = true;
    setPhase("sending");
    setRefused(false);
    setNeedsReauthentication(false);
    let refresh = false;
    try {
      const response = await adminFetch("/api/admin/amux/ideas/session-analysis-stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, claimId, ownerConfirmed: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      const row = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown> : null;
      if (response.status === 201 && row?.state === "stopped" &&
          row.ideaId === ideaId && row.claimId === claimId &&
          typeof row.auditId === "string") {
        window.sessionStorage.removeItem(storageKey);
        setPhase("stopped");
      } else if ([400, 403, 404, 409, 415, 428, 429].includes(response.status)) {
        // Decided before or by a refused transaction: show what runs now.
        window.sessionStorage.removeItem(storageKey);
        setNeedsReauthentication(response.status === 428);
        setRefused(true);
        refresh = true;
      } else setPhase("unknown");
    } catch { setPhase("unknown"); }
    finally { inFlight.current = false; }
    if (refresh) await readBack();
  };

  if (phase === "hidden" && !refused) return null;
  return <section className="space-y-2 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-sm"
    data-testid="amux-v19-session-analysis-stop" data-state={phase}>
    {phase === "checking" || phase === "sending" ? <p role="status">{m.title}</p> : null}
    {refused ? <p role="alert">{m.refused}</p> : null}
    {phase === "running" ? <>
      <p className="font-medium text-zinc-100">{m.title}</p>
      <p className="text-zinc-300">{m.startedAt(startedAt ?? "—")}</p>
      <p className="text-zinc-300" aria-live="off">{m.elapsed(duration(startedAt, now))}</p>
      <button type="button" onClick={() => void stop()}
        className="min-h-11 rounded-lg border border-red-500 px-4 font-medium text-red-300 hover:bg-red-500/10">
        {m.action}
      </button>
    </> : null}
    {phase === "stopped" ? <p role="status" className="text-zinc-100">{m.stopped}</p> : null}
    {phase === "unknown" ? <>
      <p role="alert" className="text-amber-200">{m.unknown}</p>
      <button type="button" onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-600 px-4">{m.readBack}</button>
    </> : null}
    {phase === "unavailable" ? <p role="alert">{m.unavailable}</p> : null}
    {needsReauthentication ? <a className="underline text-blue-200"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.reauthenticate}</a> : null}
  </section>;
}
