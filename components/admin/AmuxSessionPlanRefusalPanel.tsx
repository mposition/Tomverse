"use client";

import { useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";

type Refusal = { refusalId: string; chunkIndex: number; detail: string;
  at?: { rule: string; field?: string; unit?: number; kind?: string } };

/** Reads now and every `everyMs`, so a refusal that arrives while the detail
 * stays open still shows, also after a run decided again is refused again. A
 * failed read keeps what is shown. Returns the stop. */
export function watchAmuxPlanRefusal(read: () => Promise<Refusal | null>,
  apply: (refusal: Refusal | null) => void, everyMs = 30_000) {
  let active = true;
  const tick = async () => {
    try {
      const refusal = await read();
      if (active) apply(refusal);
    } catch { /* The panel is an extra way to decide; the card still waits. */ }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  return () => { active = false; clearInterval(timer); };
}

/** A refused analysis answer holds the idea for a decision (owner decision
 * 2026-11-05). Renders nothing unless this idea is waiting on one. */
export function AmuxSessionPlanRefusalPanel({ ideaId }: { ideaId: string }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => watchAmuxPlanRefusal(async () => {
    const response = await adminFetch(
      `/api/admin/amux/ideas/session-plan-refusal?${new URLSearchParams({ ideaId })}`,
      { cache: "no-store" });
    if (!response.ok) throw new Error("plan_refusal_unavailable");
    return (await response.json() as { refusal: Refusal | null }).refusal;
  }, setRefusal), [ideaId]);

  if (!refusal) return null;
  const decide = async (decision: "retry" | "stop") => {
    setPending(true);
    setFailed(false);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/session-plan-refusal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId, refusalId: refusal.refusalId, decision }) });
      if (response.ok) setRefusal(null);
      else setFailed(true);
    } catch { setFailed(true); }
    finally { setPending(false); }
  };
  const at = refusal.at;
  return (
    <section aria-labelledby="amux-plan-refusal-title" data-testid="amux-plan-refusal"
      className="space-y-2 rounded-lg border border-amber-500/40 p-3">
      <h3 id="amux-plan-refusal-title" className="font-medium text-zinc-100">{m.planRefusalTitle}</h3>
      <p className="break-words text-zinc-300" data-testid="amux-plan-refusal-reason">
        {[refusal.detail, at?.rule, at?.field, at?.unit !== undefined ? `#${at.unit}` : null, at?.kind]
          .filter(Boolean).join(" · ")}
      </p>
      <p className="text-xs text-zinc-400">{m.planRefusalHint}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => void decide("retry")}
          className="min-h-11 rounded-lg border border-zinc-600 px-3 font-medium text-zinc-100 disabled:opacity-50">
          {m.planRefusalRetry}
        </button>
        <button type="button" disabled={pending} onClick={() => void decide("stop")}
          className="min-h-11 rounded-lg border border-zinc-600 px-3 text-zinc-300 disabled:opacity-50">
          {m.planRefusalStop}
        </button>
      </div>
      {failed ? <p role="alert" className="text-red-200">{m.planRefusalFailed}</p> : null}
    </section>
  );
}
