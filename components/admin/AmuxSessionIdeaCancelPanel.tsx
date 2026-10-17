"use client";

import { useEffect, useRef, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

type Phase = "checking" | "queued" | "sending" | "unknown" |
  "cancelled" | "hidden" | "unavailable" | "refused";

/** A lost POST response becomes readback-only, including after a page reload.
 * The queue receipt remains immutable; the idea state is the dispatch fence. */
export function AmuxSessionIdeaCancelPanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages).sessionCancel;
  const [phase, setPhase] = useState<Phase>("checking");
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const inFlight = useRef(false);
  const storageKey = `amux-v19-session-cancel:${ideaId}`;

  const readBack = async (uncertain: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await adminFetch(
        `/api/admin/amux/ideas/session-cancel?${new URLSearchParams({ ideaId })}`,
        { cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 428) {
        setNeedsReauthentication(true);
        setPhase(uncertain ? "unknown" : "unavailable");
      } else if (response.ok && body && typeof body === "object" &&
          (body as { state?: unknown }).state === "cancelled" &&
          (body as { ideaId?: unknown }).ideaId === ideaId) {
        window.sessionStorage.removeItem(storageKey);
        setPhase("cancelled");
        if (uncertain) window.location.reload();
      } else if (response.ok && body && typeof body === "object" &&
          (body as { state?: unknown }).state === "queued") {
        setPhase(uncertain ? "unknown" : "queued");
      } else if (response.ok && body && typeof body === "object" &&
          (body as { state?: unknown }).state === "not_visible") {
        setPhase(uncertain ? "unknown" : "hidden");
      } else {
        setPhase(uncertain ? "unknown" : "unavailable");
      }
    } catch { setPhase(uncertain ? "unknown" : "unavailable"); }
    finally { inFlight.current = false; }
  };

  useEffect(() => {
    let uncertain = false;
    try { uncertain = window.sessionStorage.getItem(storageKey) === "pending"; }
    catch { queueMicrotask(() => setPhase("unavailable")); return; }
    queueMicrotask(() => { void readBack(uncertain); });
    // The opened idea has a stable key; switching ideas remounts this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideaId]);

  const cancel = async () => {
    if (phase !== "queued" || inFlight.current || !window.confirm(m.confirm)) return;
    try { window.sessionStorage.setItem(storageKey, "pending"); }
    catch { setPhase("unavailable"); return; }
    inFlight.current = true;
    setPhase("sending");
    setNeedsReauthentication(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/session-cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, ownerConfirmed: true }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 201 && body && typeof body === "object" &&
          (body as { state?: unknown }).state === "cancelled" &&
          (body as { ideaId?: unknown }).ideaId === ideaId &&
          typeof (body as { auditId?: unknown }).auditId === "string") {
        window.sessionStorage.removeItem(storageKey);
        setPhase("cancelled");
        window.location.reload();
      } else if ([400, 403, 404, 409, 415, 428, 429].includes(response.status)) {
        window.sessionStorage.removeItem(storageKey);
        setNeedsReauthentication(response.status === 428);
        setPhase("refused");
        if (response.status === 409) window.location.reload();
      } else setPhase("unknown");
    } catch { setPhase("unknown"); }
    finally { inFlight.current = false; }
  };

  if (phase === "hidden") return null;
  return <section className="space-y-2 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-sm"
    data-testid="amux-v19-session-cancel" data-state={phase}>
    {phase === "checking" || phase === "sending" ? <p role="status">{m.checking}</p> : null}
    {phase === "queued" ? <>
      <p className="text-zinc-300">{m.queued}</p>
      <button type="button" onClick={() => void cancel()}
        className="min-h-11 rounded-lg border border-red-500 px-4 font-medium text-red-300 hover:bg-red-500/10">
        {m.action}
      </button>
    </> : null}
    {phase === "cancelled" ? <p role="status" className="text-zinc-100">{m.cancelled}</p> : null}
    {phase === "unknown" ? <>
      <p role="alert" className="text-amber-200">{m.unknown}</p>
      <button type="button" onClick={() => void readBack(true)}
        className="min-h-11 rounded-lg border border-zinc-600 px-4">{m.readBack}</button>
    </> : null}
    {phase === "unavailable" || phase === "refused" ? <p role="alert">
      {phase === "refused" ? m.refused : m.unavailable}</p> : null}
    {needsReauthentication ? <a className="underline text-blue-200"
      href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>
      {m.reauthenticate}</a> : null}
  </section>;
}
