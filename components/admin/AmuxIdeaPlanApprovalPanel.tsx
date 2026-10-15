"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { parseAmuxIdeaAnalysisResultView,
  type AmuxVisibleAnalysisUnit } from "@/lib/amux/ideaAnalysisResultReadCore";
import { amuxV4PlanRound, amuxV4PlanScreenUnits,
  buildAmuxV4PlanRequest } from "@/lib/amux/ideaPlanScreenCore";

/** Longer than the plan transaction can run (120 s) plus the request around it. */
const PLAN_SETTLED_AFTER_MS = 180_000;
const MAX_PAGES = 20;

type Pending = { planRequestId: string; startedAt: number; unitIds: string[] };
const pendingKey = (ideaId: string) => `amux-v4-plan:${ideaId}`;
const readPending = (ideaId: string): Pending | null => {
  try {
    const raw = window.sessionStorage.getItem(pendingKey(ideaId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const row = value as Pending;
    return typeof row.planRequestId === "string" && Number.isFinite(row.startedAt) &&
      Array.isArray(row.unitIds) ? row : null;
  } catch { return null; }
};
const writePending = (ideaId: string, value: Pending | null) => {
  try {
    if (value === null) window.sessionStorage.removeItem(pendingKey(ideaId));
    else window.sessionStorage.setItem(pendingKey(ideaId), JSON.stringify(value));
  } catch { /* the server's derived ids still refuse a resend of the same plan */ }
};

/** Every page of an idea's analysis, so the screen shows all that the server approves. */
async function readAllUnits(ideaId: string): Promise<AmuxVisibleAnalysisUnit[] | null> {
  const units: AmuxVisibleAnalysisUnit[] = [];
  let page = 0;
  for (let read = 0; read < MAX_PAGES; read += 1) {
    const params = new URLSearchParams({ ideaId, chunkIndex: String(page) });
    const response = await adminFetch(`/api/admin/amux/ideas/analysis-result?${params}`, { cache: "no-store" });
    const view = parseAmuxIdeaAnalysisResultView(response.status, await response.json(), ideaId);
    if (!view || (view.state !== "ready" && view.state !== "partial")) return null;
    units.push(...view.units);
    if (view.state === "ready") return units;
    page = view.nextChunkIndex;
  }
  return null;
}

/**
 * The owner's one plan approval (amux-intake.md v18 item 3): every proposed
 * node and the first round of Stories and Tasks, across every analysis page,
 * with scores and public PR consent, in one request and one transaction. The
 * request names exactly the units shown; the server refuses any difference.
 * A lost answer is never re-posted: the attempt is remembered before the
 * request and is released only when a fresh read shows it settled.
 */
export function AmuxIdeaPlanApprovalPanel({ ideaId, onChanged }: { ideaId: string; onChanged: () => void }) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const [units, setUnits] = useState<AmuxVisibleAnalysisUnit[] | null | "failed">(null);
  const [edits, setEdits] = useState<Map<string, Record<string, number>>>(new Map());
  const [consentOff, setConsentOff] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"idle" | "pending" | "unknown" | "processing">("idle");
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const load = useCallback(() => readAllUnits(ideaId).catch(() => null), [ideaId]);
  useEffect(() => {
    let active = true;
    void load().then((read) => { if (active) setUnits(read ?? "failed"); });
    return () => { active = false; };
  }, [load]);

  const listed = useMemo(() => Array.isArray(units) ? amuxV4PlanScreenUnits(units) : [], [units]);
  const round = useMemo(() => {
    try { return amuxV4PlanRound(listed); } catch { return null; }
  }, [listed]);
  const preview = useMemo(() => round ? buildAmuxV4PlanRequest({ ideaId,
    planRequestId: "00000000-0000-4000-8000-000000000000", units: listed, edits, consentOff }) : null,
  [ideaId, listed, edits, consentOff, round]);

  if (units === null) return <p role="status">{m.planApprovalLoading}</p>;
  if (units === "failed") return <p role="alert">{m.planApprovalLoadFailed}</p>;
  if (listed.length === 0) return null;
  const scored = new Set(preview?.scoreTaskUnitIds ?? []);
  const deferred = new Set(round?.deferred ?? []);

  const approve = async () => {
    if (state !== "idle" || !preview) return;
    // An earlier attempt whose answer was lost is read back first, never sent again.
    if (readPending(ideaId)) { setState("unknown"); return; }
    const planRequestId = crypto.randomUUID();
    const body = buildAmuxV4PlanRequest({ ideaId, planRequestId, units: listed, edits, consentOff });
    writePending(ideaId, { planRequestId, startedAt: Date.now(), unitIds: body.expectedUnitIds });
    setState("pending");
    setFailure(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/plan", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (response.status === 201) {
        writePending(ideaId, null);
        setState("idle");
        onChanged();
        setUnits(await load() ?? "failed");
        return;
      }
      if ([400, 401, 403, 404, 409, 413, 415, 428].includes(response.status)) {
        // A refusal inside the one transaction: nothing was recorded. Read the
        // plan again, so a unit decided elsewhere meanwhile is not resent.
        setFailure(await readAdminApiFailure(response, { fallback: m.transferConfirmRefused, locale }));
        writePending(ideaId, null);
        setUnits(await load() ?? "failed");
        setState("idle");
        return;
      }
    } catch { /* A lost answer is read back, never re-posted. */ }
    setState("unknown");
  };

  const readBack = async () => {
    const pending = readPending(ideaId);
    const read = await load();
    if (!read) { setState("unknown"); return; }
    setUnits(read);
    if (!pending) { setState("idle"); onChanged(); return; }
    const stillProposed = read.filter((unit) => pending.unitIds.includes(unit.id) &&
      unit.decisionState === "proposed");
    // All or nothing: none proposed means it committed; all still proposed
    // long after it could have run means it did not. Anything sooner waits.
    if (stillProposed.length === 0 ||
        (stillProposed.length === pending.unitIds.length &&
          Date.now() - pending.startedAt > PLAN_SETTLED_AFTER_MS)) {
      writePending(ideaId, null);
      setState("idle");
      onChanged();
      return;
    }
    setState("processing");
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
        const later = deferred.has(unit.unitId);
        return <li key={unit.unitId} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{unit.kind}{unit.taskRole ? ` · ${unit.taskRole}` : ""}</p>
          <p className="font-medium">{unit.title}</p>
          {later ? <p className="text-xs">{m.planApprovalNextRound}</p> : null}
          {metrics && !later ? <fieldset className="mt-2 flex flex-wrap gap-2">
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
          {unit.kind === "task" && !later ? <p className="mt-1 text-xs">
            {scored.has(unit.unitId) ? m.planApprovalScored : m.planApprovalNotScored}
          </p> : null}
          {unit.kind === "task" && unit.taskRole === "implement" && !later ? <label className="mt-2 flex items-center gap-2">
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
    {state === "idle" && preview ? <button type="button" onClick={() => void approve()}
      className="min-h-11 rounded-lg border border-blue-700 bg-blue-700 px-4 text-white dark:border-blue-400">
      {m.planApprovalAction}
    </button> : null}
    {!preview ? <p role="alert">{m.planApprovalLoadFailed}</p> : null}
    {state === "pending" ? <p role="status">{m.planApprovalPending}</p> : null}
    {state === "unknown" || state === "processing" ? <div className="space-y-2">
      <p role="alert">{state === "processing" ? m.planApprovalStillProcessing : m.planApprovalUnknown}</p>
      <button type="button" onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
        {m.planApprovalReadBack}
      </button>
    </div> : null}
    {failure ? <AdminApiFailureNotice failure={failure} /> : null}
  </section>;
}
