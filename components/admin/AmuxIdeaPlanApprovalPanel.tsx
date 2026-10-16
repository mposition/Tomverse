"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS } from "@/lib/amux/ideaRequestTimeoutsCore";
import { parseAmuxIdeaAnalysisResultView,
  type AmuxVisibleAnalysisUnit } from "@/lib/amux/ideaAnalysisResultReadCore";
import { amuxV4PlanRound, amuxV4PlanScreenUnits,
  buildAmuxV4PlanRequest } from "@/lib/amux/ideaPlanScreenCore";
import { decidePlanReadBack, planReadBackSeconds,
  type PlanReadBackOutcome } from "@/lib/amux/ideaPlanReadBackCore";

const MAX_PAGES = 20;

type Messages = (typeof adminAmuxIdeaInputMessages)["en"];

/** What the last "check what was recorded" showed; `reading` while it runs. */
export type ReadBackView =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "outcome"; outcome: Exclude<PlanReadBackOutcome, { kind: "no_attempt" }>; settlesAt: number };

const NOTICE_CLASS: Record<string, string> = {
  recorded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  not_recorded: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  settling: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  read_failed: "border-red-500/30 bg-red-500/10 text-red-200",
  mixed: "border-red-500/30 bg-red-500/10 text-red-200",
  reading: "border-blue-500/30 bg-blue-500/10 text-blue-200",
};

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

/**
 * The answer of the last "check what was recorded", without hooks so a test can
 * call it. Each outcome says something different: reading (busy), recorded,
 * not recorded (safe to approve again), still settling (with the seconds left)
 * and a failed read. A recorded plan leaves nothing to approve, so this notice
 * is also what the panel renders once its list of proposals is empty.
 */
export function AmuxIdeaPlanReadBackNotice({ m, view, clock }: { m: Messages; view: ReadBackView; clock: number }) {
  if (view.kind === "none") return null;
  if (view.kind === "reading") {
    return <p role="status" aria-live="polite" data-testid="amux-plan-readback-reading"
      className={`rounded-lg border p-3 ${NOTICE_CLASS.reading}`}>{m.planApprovalReading}</p>;
  }
  const { outcome, settlesAt } = view;
  const remainingMs = settlesAt - clock;
  const text = outcome.kind === "recorded" ? m.planApprovalRecorded
    : outcome.kind === "not_recorded" ? m.planApprovalNotRecorded
      : outcome.kind === "read_failed" ? m.planApprovalReadFailed
        : outcome.kind === "mixed" ? m.planApprovalMixed
          : remainingMs > 0 ? m.planApprovalSettling(planReadBackSeconds(remainingMs)) : m.planApprovalSettled;
  return <p role={outcome.kind === "recorded" ? "status" : "alert"} data-testid={`amux-plan-readback-${outcome.kind}`}
    className={`rounded-lg border p-3 ${NOTICE_CLASS[outcome.kind]}`}>{text}</p>;
}

/** The button of an unknown or processing approval; disabled and busy while it reads. */
export function AmuxIdeaPlanReadBackButton({ m, view, onClick }: { m: Messages; view: ReadBackView; onClick: () => void }) {
  return <button type="button" onClick={onClick} disabled={view.kind === "reading"}
    aria-busy={view.kind === "reading"} data-testid="amux-plan-readback-button"
    className="min-h-11 rounded-lg border px-4 border-zinc-600 disabled:opacity-50">
    {m.planApprovalReadBack}
  </button>;
}

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
  const [readBackView, setReadBackView] = useState<ReadBackView>({ kind: "none" });
  // A ticking clock only while a wait is on screen, so its seconds count down.
  const [clock, setClock] = useState(() => Date.now());
  const settling = readBackView.kind === "outcome" && readBackView.outcome.kind === "settling";
  useEffect(() => {
    if (!settling) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [settling]);

  const load =useCallback(() => readAllUnits(ideaId).catch(() => null), [ideaId]);
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

  // The answer of the last read-back: each outcome says something different, and a recorded plan
  // leaves nothing to approve, so its notice must outlive the list of proposals.
  const readBackNotice = <AmuxIdeaPlanReadBackNotice m={m} view={readBackView} clock={clock} />;

  if (units === null) return <p role="status">{m.planApprovalLoading}</p>;
  if (units === "failed") return <p role="alert">{m.planApprovalLoadFailed}</p>;
  if (listed.length === 0) return readBackNotice;
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
    setReadBackView({ kind: "none" });
    try {
      // The server approves in one transaction that may run for 120 s. The default 15 s deadline
      // aborted the request in production while the approval was still being recorded, and the
      // operator saw an unknown outcome for a write that went on to commit. A lost answer is
      // still read back below, never re-posted.
      const response = await adminFetch("/api/admin/amux/ideas/plan", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        timeoutMs: AMUX_IDEA_PLAN_APPROVAL_REQUEST_TIMEOUT_MS,
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

  // Reads what the lost attempt left behind and says which of its outcomes it is. It only ever
  // reads: the approval is never posted again from here.
  const readBack = async () => {
    if (readBackView.kind === "reading") return;
    setReadBackView({ kind: "reading" });
    const attempt = readPending(ideaId);
    const read = await load();
    const outcome = decidePlanReadBack({ attempt, units: read, now: Date.now() });
    if (read) setUnits(read);
    const now = Date.now();
    setClock(now);
    switch (outcome.kind) {
      case "no_attempt":
        // Settled elsewhere meanwhile: the screen is current again.
        setReadBackView({ kind: "none" });
        setState("idle");
        onChanged();
        return;
      case "read_failed":
        setState("unknown");
        setReadBackView({ kind: "outcome", outcome, settlesAt: now });
        return;
      case "recorded":
      case "not_recorded":
        // Nothing is left in doubt: the attempt is released (a recorded plan has nothing to approve,
        // an unrecorded one may be approved again) and the parent reads its own state again.
        writePending(ideaId, null);
        setState("idle");
        setReadBackView({ kind: "outcome", outcome, settlesAt: now });
        onChanged();
        return;
      case "settling":
        setState("processing");
        setReadBackView({ kind: "outcome", outcome, settlesAt: now + outcome.remainingMs });
        return;
      case "mixed":
        setState("processing");
        setReadBackView({ kind: "outcome", outcome, settlesAt: now });
        return;
    }
  };

  const setMetric = (unitId: string, base: Record<string, number>, key: string, value: number) => {
    setEdits((current) => new Map(current).set(unitId, { ...(current.get(unitId) ?? base), [key]: value }));
  };

  return <section className="space-y-3 rounded-xl border p-4 text-sm border-zinc-700"
    aria-labelledby={`amux-v4-plan-${ideaId}`}>
    <h4 id={`amux-v4-plan-${ideaId}`} className="font-semibold">{m.planApprovalTitle}</h4>
    <p className="text-zinc-300">{m.planApprovalHint}</p>
    <ul className="space-y-2">
      {listed.map((unit) => {
        const metrics = edits.get(unit.unitId) ?? unit.metrics;
        const later = deferred.has(unit.unitId);
        return <li key={unit.unitId} className="rounded-lg border p-3 border-zinc-800">
          <p className="text-xs text-zinc-400">{unit.kind}{unit.taskRole ? ` · ${unit.taskRole}` : ""}</p>
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
                className="min-h-11 w-16 rounded border px-2 border-zinc-700 bg-zinc-900" />
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
      className="min-h-11 rounded-lg border bg-blue-700 px-4 text-white border-blue-400">
      {m.planApprovalAction}
    </button> : null}
    {!preview ? <p role="alert">{m.planApprovalLoadFailed}</p> : null}
    {state === "pending" ? <p role="status">{m.planApprovalPending}</p> : null}
    {state === "unknown" || state === "processing" ? <div className="space-y-2">
      {/* Until a check has answered, the standing explanation; afterwards the answer replaces it. */}
      {readBackView.kind === "none"
        ? <p role="alert">{state === "processing" ? m.planApprovalStillProcessing : m.planApprovalUnknown}</p> : null}
      {readBackNotice}
      <AmuxIdeaPlanReadBackButton m={m} view={readBackView} onClick={() => void readBack()} />
    </div> : readBackNotice}
    {failure ? <AdminApiFailureNotice failure={failure} /> : null}
  </section>;
}
