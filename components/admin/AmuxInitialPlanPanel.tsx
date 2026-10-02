"use client";

import { useCallback, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  classifyInitialPlanPost, classifyInitialPlanReadback,
  clearPendingInitialPlan, readPendingInitialPlan, reservePendingInitialPlan,
} from "@/lib/amux/ideaInitialPlanUiCore";

type PlanState =
  | { kind: "idle" }
  | { kind: "pending"; ideaId: string }
  | { kind: "committed"; ideaId: string; revisionId: string }
  | { kind: "outcome_unknown"; ideaId: string }
  | { kind: "refused"; code: string }
  | { kind: "recovery_unavailable" };

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

/** Idea-only plan preparation. The opaque idea ID is the recovery key. */
export function AmuxInitialPlanPanel({ ideaId, operatorId, available, declaredExternalSources }: {
  ideaId: string | null; operatorId: string; available: boolean; declaredExternalSources: boolean;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const [state, setState] = useState<PlanState>({ kind: "idle" });
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [readBackPending, setReadBackPending] = useState(false);

  const readBack = useCallback(async (pendingIdeaId: string) => {
    setReadBackPending(true);
    try {
      const query = new URLSearchParams({ ideaId: pendingIdeaId });
      const response = await adminFetch(`/api/admin/amux/ideas/initial-source-plan?${query}`, { cache: "no-store" });
      const decision = classifyInitialPlanReadback({ status: response.status,
        body: await response.json() }, pendingIdeaId);
      if (decision.kind === "committed") {
        clearPendingInitialPlan(receiptStore(), operatorId, pendingIdeaId);
        setState({ kind: "committed", ideaId: pendingIdeaId, revisionId: decision.revisionId });
      } else {
        setState({ kind: "outcome_unknown", ideaId: pendingIdeaId });
      }
    } catch { setState({ kind: "outcome_unknown", ideaId: pendingIdeaId }); }
    finally { setReadBackPending(false); }
  }, [operatorId]);

  useEffect(() => {
    let active = true;
    const receipt = readPendingInitialPlan(receiptStore(), operatorId);
    queueMicrotask(() => {
      if (!active) return;
      if (receipt.kind === "pending") {
        setState({ kind: "outcome_unknown", ideaId: receipt.ideaId });
        void readBack(receipt.ideaId);
      } else if (receipt.kind === "unavailable") {
        setState({ kind: "recovery_unavailable" });
      }
      setRecoveryChecked(true);
    });
    return () => { active = false; };
  }, [operatorId, readBack]);

  const prepare = async () => {
    if (!ideaId || !available || declaredExternalSources || !recoveryChecked ||
        state.kind !== "idle") return;
    if (!reservePendingInitialPlan(receiptStore(), operatorId, ideaId)) {
      setState({ kind: "recovery_unavailable" });
      return;
    }
    setState({ kind: "pending", ideaId });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/initial-source-plan", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, ideaId }),
      });
      const decision = classifyInitialPlanPost({ status: response.status,
        body: await response.json() }, ideaId);
      if (decision.kind === "committed") {
        clearPendingInitialPlan(receiptStore(), operatorId, ideaId);
        setState({ kind: "committed", ideaId, revisionId: decision.revisionId });
      } else if (decision.kind === "refused") {
        clearPendingInitialPlan(receiptStore(), operatorId, ideaId);
        setState({ kind: "refused", code: decision.code });
      } else {
        await readBack(ideaId);
      }
    } catch { await readBack(ideaId); }
  };

  if (!ideaId && state.kind === "idle") return null;
  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      aria-labelledby="amux-v4-initial-plan-heading">
      <h3 id="amux-v4-initial-plan-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">{m.initialPlanTitle}</h3>
      <p className="text-zinc-700 dark:text-zinc-300">{m.initialPlanHint}</p>
      {ideaId && declaredExternalSources ? <p>{m.initialPlanExternalScope}</p> : null}
      {ideaId && !declaredExternalSources && state.kind === "idle" ? (
        <button type="button" onClick={prepare} disabled={!available || !recoveryChecked}
          className="min-h-11 rounded-lg border border-blue-700 px-4 font-medium text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
          {m.initialPlanPrepare}
        </button>
      ) : null}
      {!available ? <p className="text-zinc-600 dark:text-zinc-400">{m.initialPlanUnavailable}</p> : null}
      {state.kind === "pending" ? <p role="status">{m.initialPlanPreparing}</p> : null}
      {state.kind === "committed" ? <p role="status">{m.initialPlanCommitted(state.ideaId)}</p> : null}
      {state.kind === "refused" ? <p role="alert">{m.initialPlanRefused(state.code)}</p> : null}
      {state.kind === "recovery_unavailable" ? <p role="alert">{m.recoveryUnavailable}</p> : null}
      {state.kind === "outcome_unknown" ? (
        <div role="alert" className="space-y-2">
          <p>{m.initialPlanUnknown(state.ideaId)}</p>
          <button type="button" onClick={() => readBack(state.ideaId)} disabled={readBackPending}
            className="min-h-11 rounded-lg border border-amber-700 px-3 font-medium disabled:opacity-50 dark:border-amber-300">
            {m.checkSubmissionStatus}
          </button>
        </div>
      ) : null}
    </section>
  );
}
