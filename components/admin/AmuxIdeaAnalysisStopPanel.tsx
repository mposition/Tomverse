"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { useModalDialog } from "@/components/useModalDialog";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxAnalysisBudgetMessages } from "@/lib/adminMessages/amuxAnalysisBudget";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { amuxAnalysisStopRequestKey, classifyAmuxAnalysisStopPost,
  isAmuxAnalysisStopRequestId,
  parseAmuxAnalysisStopReceipt } from "@/lib/amux/ideaAnalysisStopUiCore";

type Phase = "loading" | "idle" | "sending" | "unknown" | "stopped" |
  "unavailable";

function duration(startedAt: string | null, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return "—";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60,
    seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Owner-confirmed stop. A persisted request ID turns any uncertain POST into
 * read-back only; even a missing receipt never enables another POST. */
export function AmuxIdeaAnalysisStopPanel({ holdId, previewId, ideaId,
  holdStatus, dispatchedAt, onStopped }: {
  holdId: string; previewId: string; ideaId: string;
  holdStatus: string; dispatchedAt: string | null;
  onStopped: () => void;
}) {
  const m = useAdminMessages(adminAmuxAnalysisBudgetMessages).stop;
  const [phase, setPhase] = useState<Phase>("loading");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [refused, setRefused] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inFlight = useRef(false);
  useModalDialog({ open, onClose: () => { if (!inFlight.current) setOpen(false); },
    dialogRef, panelRef: dialogRef, initialFocusRef: cancelRef,
    returnFocusRef: triggerRef });

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = window.sessionStorage.getItem(amuxAnalysisStopRequestKey(holdId));
        if (saved !== null && !isAmuxAnalysisStopRequestId(saved)) {
          setPhase("unavailable"); return;
        }
        setRequestId(saved);
        setPhase(saved ? "unknown" : "idle");
      } catch { setPhase("unavailable"); }
    });
    return () => { active = false; };
  }, [holdId]);

  useEffect(() => {
    if (holdStatus !== "in_flight") return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [holdStatus]);

  const expected = { holdId, previewId, ideaId };
  const submit = async () => {
    if (phase !== "idle" || holdStatus !== "in_flight" || inFlight.current) return;
    const id = crypto.randomUUID();
    try {
      window.sessionStorage.setItem(amuxAnalysisStopRequestKey(holdId), id);
    } catch { setPhase("unavailable"); setOpen(false); return; }
    setRequestId(id);
    setNeedsReauthentication(false);
    setRefused(false);
    setPhase("sending");
    inFlight.current = true;
    try {
      const response = await adminFetch("/api/admin/amux/ideas/analysis-stop", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopRequestId: id, holdId,
          ownerConfirmed: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      const decision = classifyAmuxAnalysisStopPost(response.status, body, expected);
      if (decision.kind === "committed") {
        setPhase("stopped"); onStopped();
      } else if (decision.kind === "refused") {
        // The server definitively refused this request. Only a successfully
        // cleared receipt allows a new owner-confirmed attempt.
        try {
          window.sessionStorage.removeItem(amuxAnalysisStopRequestKey(holdId));
          setRequestId(null);
          setRefused(true);
          setNeedsReauthentication(response.status === 428);
          setPhase("idle");
          if (response.status === 409) onStopped();
        } catch { setPhase("unknown"); }
      } else {
        setPhase("unknown");
      }
    } catch { setPhase("unknown"); }
    finally { inFlight.current = false; setOpen(false); }
  };

  const readBack = async () => {
    if (phase !== "unknown" || !requestId || inFlight.current) return;
    inFlight.current = true;
    setNeedsReauthentication(false);
    try {
      const query = new URLSearchParams({ stopRequestId: requestId });
      const response = await adminFetch(`/api/admin/amux/ideas/analysis-stop?${query}`,
        { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (parseAmuxAnalysisStopReceipt(response.status, body, expected, true)) {
        setPhase("stopped"); onStopped();
      } else setNeedsReauthentication(response.status === 428);
    } catch { /* Keep the saved request ID and the read-back-only state. */ }
    finally { inFlight.current = false; }
  };

  if (holdStatus !== "in_flight" &&
      (holdStatus !== "outcome_unknown" ||
        (phase !== "unknown" && phase !== "stopped"))) return null;
  return <div className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
    data-testid="amux-v19-analysis-stop-panel">
    {phase === "stopped" ? <>
      <p role="status" className="font-semibold text-zinc-100">{m.stopped}</p>
      <p className="text-zinc-300">{m.stoppedHint}</p>
    </> : holdStatus === "in_flight" ? <>
      <p className="font-semibold text-zinc-100">{m.running}</p>
      <p className="text-zinc-300">{m.elapsed(duration(dispatchedAt, now))}</p>
      <p className="text-zinc-400">{m.noDeadline}</p>
    </> : null}
    {phase === "idle" && holdStatus === "in_flight" ? <button ref={triggerRef}
      type="button" onClick={() => setOpen(true)}
      className="min-h-11 rounded-lg border border-red-500 px-4 font-medium text-red-300 hover:bg-red-500/10">
      {m.action}
    </button> : null}
    {phase === "unknown" ? <>
      <p role="alert" className="text-amber-200">{m.unknown}</p>
      <button type="button" onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-600 px-4">
        {m.readBack}
      </button>
    </> : null}
    {phase === "unavailable" ? <p role="alert">{m.unavailable}</p> : null}
    {refused ? <p role="alert">{m.refused}</p> : null}
    {needsReauthentication ? <a className="underline"
      href={adminRecentAuthenticationHref(typeof window === "undefined"
        ? "/admin/amux-backlog?tab=ideas"
        : `${window.location.pathname}${window.location.search}`)}>
      {phase === "unknown" ? m.reauthenticateToReadBack :
        m.reauthenticateToStop}
    </a> : null}
    {open && typeof document !== "undefined" ? createPortal(
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-4">
        <div ref={dialogRef} role="dialog" aria-modal="true"
          aria-labelledby="amux-v19-stop-title" aria-describedby="amux-v19-stop-description"
          className="w-full max-w-md space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5 text-zinc-100 shadow-2xl">
          <h2 id="amux-v19-stop-title" className="text-lg font-semibold">{m.confirmTitle}</h2>
          <div id="amux-v19-stop-description" className="space-y-2 text-sm text-zinc-300">
            <p>{m.elapsed(duration(dispatchedAt, now))}</p>
            <p>{m.confirmHint}</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>{m.unknownOutcome}</li><li>{m.lateResult}</li>
              <li>{m.agentCost}</li>
            </ul>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button ref={cancelRef} type="button" disabled={phase === "sending"}
              onClick={() => setOpen(false)}
              className="min-h-11 rounded-lg border border-zinc-600 px-4 disabled:opacity-50">
              {m.continue}
            </button>
            <button type="button" disabled={phase === "sending"}
              onClick={() => void submit()}
              className="min-h-11 rounded-lg bg-red-600 px-4 font-semibold text-white disabled:opacity-50">
              {phase === "sending" ? m.sending : m.action}
            </button>
          </div>
        </div>
      </div>, document.body) : null}
  </div>;
}
