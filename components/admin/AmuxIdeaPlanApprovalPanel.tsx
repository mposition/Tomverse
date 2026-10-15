"use client";

import { useMemo, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import type { AmuxVisibleAnalysisUnit } from "@/lib/amux/ideaAnalysisResultReadCore";
import { amuxV4PlanScreenUnits, buildAmuxV4PlanRequest } from "@/lib/amux/ideaPlanScreenCore";

const pendingKey = (ideaId: string) => `amux-v4-plan:${ideaId}`;
const readPending = (ideaId: string) => {
  try { return window.sessionStorage.getItem(pendingKey(ideaId)); } catch { return null; }
};
const writePending = (ideaId: string, value: string | null) => {
  try {
    if (value === null) window.sessionStorage.removeItem(pendingKey(ideaId));
    else window.sessionStorage.setItem(pendingKey(ideaId), value);
  } catch { /* the attempt is still guarded by the server's derived ids */ }
};

/**
 * The owner's one plan approval (amux-intake.md v18 item 3): every proposed
 * node, Story and Task with its score and public PR consent, approved in one
 * request and one transaction. Model-derived text renders as React text. A
 * lost answer is never re-posted: the attempt is remembered before the
 * request and the analysis result is read again instead.
 */
export function AmuxIdeaPlanApprovalPanel({ ideaId, units, onChanged }: {
  ideaId: string; units: readonly AmuxVisibleAnalysisUnit[]; onChanged: () => void;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const listed = useMemo(() => amuxV4PlanScreenUnits(units), [units]);
  const [edits, setEdits] = useState<Map<string, Record<string, number>>>(new Map());
  const [consentOff, setConsentOff] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"idle" | "pending" | "unknown">("idle");
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const preview = useMemo(() => buildAmuxV4PlanRequest({ ideaId,
    planRequestId: "00000000-0000-4000-8000-000000000000", units: listed, edits, consentOff }),
  [ideaId, listed, edits, consentOff]);
  if (listed.length === 0) return null;
  const scored = new Set(preview.scoreTaskUnitIds);

  const approve = async () => {
    if (state !== "idle") return;
    // An earlier attempt whose answer was lost (this tab, or before a reload)
    // is read back first; it is never sent again blind.
    if (readPending(ideaId)) { setState("unknown"); return; }
    const planRequestId = crypto.randomUUID();
    writePending(ideaId, planRequestId);
    setState("pending");
    setFailure(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/plan", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAmuxV4PlanRequest({ ideaId, planRequestId, units: listed, edits, consentOff })),
      });
      if (response.status === 201) {
        writePending(ideaId, null);
        setState("idle");
        onChanged();
        return;
      }
      if ([400, 401, 403, 404, 409, 413, 415, 428].includes(response.status)) {
        // A refusal inside the one transaction: nothing was recorded.
        setFailure(await readAdminApiFailure(response, { fallback: m.transferConfirmRefused, locale }));
        writePending(ideaId, null);
        setState("idle");
        return;
      }
    } catch { /* A lost answer is read back, never re-posted. */ }
    setState("unknown");
  };

  const readBack = () => {
    // The plan is all or nothing: units still proposed after this read were not registered.
    writePending(ideaId, null);
    setState("idle");
    onChanged();
  };

  const setMetric = (unitId: string, base: Record<string, number>, key: string, value: number) => {
    setEdits((current) => new Map(current).set(unitId, { ...(current.get(unitId) ?? base), [key]: value }));
  };

  return <section className="space-y-3 rounded-xl border border-zinc-300 p-4 text-sm dark:border-zinc-700"
    aria-labelledby={`amux-v4-plan-${ideaId}`}>
    <h4 id={`amux-v4-plan-${ideaId}`} className="font-semibold">{m.planApprovalTitle}</h4>
    <p className="text-zinc-700 dark:text-zinc-300">{m.planApprovalHint}</p>
    <ul className="space-y-2">
      {listed.map((unit) => {
        const metrics = edits.get(unit.unitId) ?? unit.metrics;
        return <li key={unit.unitId} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{unit.kind}{unit.taskRole ? ` · ${unit.taskRole}` : ""}</p>
          <p className="font-medium">{unit.title}</p>
          {metrics ? <fieldset className="mt-2 flex flex-wrap gap-2">
            <legend className="sr-only">{m.planApprovalScoreLabel}</legend>
            {Object.entries(metrics).map(([key, value]) => <label key={key} className="flex items-center gap-1 text-xs">
              {key}
              <input type="number" min={0} max={5} step={1} value={value}
                disabled={state !== "idle"}
                onChange={(event) => setMetric(unit.unitId, metrics, key,
                  Math.max(0, Math.min(5, Math.trunc(Number(event.target.value) || 0))))}
                className="min-h-11 w-16 rounded border border-zinc-300 px-2 dark:border-zinc-700 dark:bg-zinc-900" />
            </label>)}
          </fieldset> : null}
          {unit.kind === "task" ? <p className="mt-1 text-xs">
            {scored.has(unit.unitId) ? m.planApprovalScored : m.planApprovalNotScored}
          </p> : null}
          {unit.kind === "task" && unit.taskRole === "implement" ? <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={!consentOff.has(unit.unitId)} disabled={state !== "idle"}
              onChange={(event) => setConsentOff((current) => {
                const next = new Set(current);
                if (event.target.checked) next.delete(unit.unitId); else next.add(unit.unitId);
                return next;
              })} className="size-5" />
            {m.planApprovalPrConsent}
          </label> : null}
        </li>;
      })}
    </ul>
    {state === "idle" ? <button type="button" onClick={() => void approve()}
      className="min-h-11 rounded-lg border border-blue-700 bg-blue-700 px-4 text-white dark:border-blue-400">
      {m.planApprovalAction}
    </button> : null}
    {state === "pending" ? <p role="status">{m.planApprovalPending}</p> : null}
    {state === "unknown" ? <div className="space-y-2">
      <p role="alert">{m.planApprovalUnknown}</p>
      <button type="button" onClick={readBack}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
        {m.planApprovalReadBack}
      </button>
    </div> : null}
    {failure ? <AdminApiFailureNotice failure={failure} /> : null}
  </section>;
}
