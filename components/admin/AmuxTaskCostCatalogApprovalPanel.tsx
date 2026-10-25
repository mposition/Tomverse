"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const endpoint = "/api/admin/amux/task-cost-catalog";
const GRADES = ["routine", "advanced", "frontier"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const grade = z.enum(GRADES);
const skippedSchema = z.array(z.object({ workerName: z.string(), modelId: z.string(),
  reason: z.enum(["price_missing", "grade_unknown", "roles_missing"]) }).strict());
const draftSchema = z.object({ ok: z.literal(true),
  catalog: z.record(z.string(), z.unknown()), catalogDigest: digest, evidenceDigest: digest,
  routes: z.array(z.object({ workerName: z.string(), modelId: z.string(), grade,
    roles: z.array(z.string()), inputUsdPerMillion: z.number(),
    outputUsdPerMillion: z.number() }).strict()),
  skipped: skippedSchema,
  maxCostMicroUsd: z.partialRecord(grade, z.string().regex(/^\d+$/)),
  pricesExpireAt: z.string(),
  preview: z.object({ catalogDigest: digest,
    expectedPreviousVersion: z.number().int().nonnegative(),
    executionAuthorized: z.literal(false) }).passthrough() }).strict();
const refusedSchema = z.object({ ok: z.literal(false),
  code: z.enum(["caps_invalid", "no_priced_worker"]), skipped: skippedSchema }).strict();
type Draft = z.infer<typeof draftSchema>;
type Skipped = z.infer<typeof skippedSchema>;
type Grade = (typeof GRADES)[number];
type GradeCaps = { inputTokens: number; outputTokens: number; maxAttempts: number };
export type AmuxTaskCatalogCaps = Record<Grade, GradeCaps>;

/** What the page read of the latest catalog version; null when the read failed. */
export type AmuxTaskCatalogCurrentView =
  | { status: "none" }
  | { status: "unreadable"; version: number }
  | { status: "approved" | "expired" | "revoked"; version: number;
      catalogVersion: string; approvedAt: string; pricesExpireAt: string | null;
      routes: Array<{ workerName: string; modelId: string; grade: string | null;
        inputUsdPerMillion: number; outputUsdPerMillion: number }> };

const brisbaneTime = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const aest = (iso: string) => `${brisbaneTime.format(new Date(iso))} AEST`;
const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;
const microUsd = (value: string) => `$${(Number(value) / 1_000_000).toFixed(2)}`;
const STATUS_TONE: Record<string, string> = {
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  none: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  expired: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  revoked: "border-red-500/30 bg-red-500/10 text-red-300",
  unreadable: "border-red-500/30 bg-red-500/10 text-red-300",
};
const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-md border px-3 py-1 text-sm font-semibold disabled:opacity-60 border-zinc-500 text-zinc-100 hover:bg-zinc-800";
const primaryButtonClass = "inline-flex min-h-11 items-center justify-center rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60";
const stepClass = "space-y-2 rounded-lg border border-zinc-800 p-3";

const failureCode = (value: unknown) => value && typeof value === "object" &&
  "error" in value && typeof value.error === "string" ? value.error : "unavailable";

/** Owner approval of the Task cost catalog. Workers and prices are read from
 * the worker registry and Admin › Models; the owner sets only grade caps
 * (owner decision 2026-10-25). A lost approval response is resolved by exact
 * ID read-back and never blindly replayed. */
export function AmuxTaskCostCatalogApprovalPanel({ approvalAvailable, current, initialCaps }: {
  approvalAvailable: boolean;
  current: AmuxTaskCatalogCurrentView | null;
  initialCaps: AmuxTaskCatalogCaps;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const router = useRouter();
  const [caps, setCaps] = useState<AmuxTaskCatalogCaps>(initialCaps);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [skipped, setSkipped] = useState<Skipped>([]);
  const [stale, setStale] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  // The digest that approval ID was sent with: a read-back compares to it,
  // never to a later draft.
  const [submittedDigest, setSubmittedDigest] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [approved, setApproved] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showFailure = useCallback((status: number, value: unknown) => {
    const code = failureCode(value);
    if (status === 428) setReauth(true);
    if (code === "outcome_unknown") setUnknown(true);
    else setError(m.taskCatalogFailed(code));
  }, [m]);
  const calculate = useCallback(async (next: AmuxTaskCatalogCaps) => {
    setBusy(true); setError(null); setDraft(null); setConfirmed(false);
    try {
      const response = await adminFetch(endpoint, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft", caps: next }) });
      const value: unknown = await response.json().catch(() => null);
      const refused = refusedSchema.safeParse(value);
      if (response.status === 409 && refused.success) {
        setSkipped(refused.data.skipped);
        setError(refused.data.code === "caps_invalid" ? m.taskCatalogCapsInvalid :
          m.taskCatalogNoPricedWorker);
        return;
      }
      if (!response.ok) { showFailure(response.status, value); return; }
      const parsed = draftSchema.safeParse(value);
      if (!parsed.success) { setError(m.taskCatalogInvalid); return; }
      setDraft(parsed.data); setSkipped(parsed.data.skipped); setStale(false);
    } catch { setError(m.taskCatalogInvalid); }
    finally { setBusy(false); }
  }, [m, showFailure]);
  // A draft writes nothing, so the panel shows today's prices when it opens.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void calculate(initialCaps);
  }, [calculate, initialCaps]);

  const setCap = (key: Grade, field: keyof GradeCaps, raw: string) => {
    const value = Number(raw);
    setCaps((previous) => ({ ...previous, [key]: { ...previous[key],
      [field]: Number.isFinite(value) ? value : 0 } }));
    setStale(true); setConfirmed(false);
  };
  const approve = async () => {
    if (!approvalAvailable || !draft || stale || busy || unknown || approved ||
        !confirmed) return;
    const id = crypto.randomUUID();
    setApprovalId(id); setSubmittedDigest(draft.catalogDigest);
    setBusy(true); setError(null); setReauth(false);
    try {
      const response = await adminFetch(endpoint, { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", approvalId: id, catalog: draft.catalog,
          catalogDigest: draft.catalogDigest, evidenceDigest: draft.evidenceDigest,
          expectedPreviousVersion: draft.preview.expectedPreviousVersion,
          ownerConfirmedEvidence: true }) });
      if (!response.ok) {
        showFailure(response.status, await response.json().catch(() => null));
        return;
      }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("approvalId" in value) ||
          value.approvalId !== id || !("catalogDigest" in value) ||
          value.catalogDigest !== draft.catalogDigest) {
        setUnknown(true); return;
      }
      setApproved(true); router.refresh();
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    if (!approvalId || !submittedDigest || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await adminFetch(`${endpoint}/${approvalId}`, { cache: "no-store" });
      if (!response.ok) {
        showFailure(response.status, await response.json().catch(() => null));
        return;
      }
      const value: unknown = await response.json();
      if (value && typeof value === "object" && "state" in value &&
          value.state === "approved" && "catalogDigest" in value &&
          value.catalogDigest === submittedDigest) {
        setApproved(true); setUnknown(false); router.refresh();
      } else setUnknown(true);
    } catch { setUnknown(true); }
    finally { setBusy(false); }
  };

  const status = current?.status ?? "unreadable";
  const routes = draft?.routes ?? (current && "routes" in current ? current.routes : []);
  return <section data-testid="amux-task-cost-catalog"
    className="space-y-3 rounded-xl border border-zinc-700 p-4 text-sm">
    <header className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">{m.taskCatalogTitle}</h3>
        <span data-testid="amux-task-cost-catalog-status"
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[status]}`}>
          {m.taskCatalogStatus[status]}</span>
      </div>
      {current && "approvedAt" in current ? <p className="text-xs text-zinc-400 tabular-nums">
        {m.taskCatalogStatusDetail(current.version, aest(current.approvedAt),
          current.pricesExpireAt ? aest(current.pricesExpireAt) : null)}</p> : null}
      {status === "none" ? <p className="text-amber-300">{m.taskCatalogStatusNone}</p> : null}
      {status === "expired" || status === "revoked" ?
        <p className="text-amber-300">{m.taskCatalogStatusExpired}</p> : null}
      <p className="max-w-prose text-zinc-300">{m.taskCatalogHint}</p>
      {!approvalAvailable ? <p role="status" className="text-zinc-400">{m.taskCatalogDisabled}</p> : null}
    </header>

    <div className={stepClass}>
      <h4 className="font-semibold">{m.taskCatalogStepPrices}</h4>
      <p className="text-xs text-zinc-400">{m.taskCatalogStepPricesHint}</p>
      {routes.length > 0 ? <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left tabular-nums">
          <thead className="text-xs text-zinc-400"><tr>
            <th className="py-1 pr-3 font-medium">{m.taskCatalogColWorker}</th>
            <th className="py-1 pr-3 font-medium">{m.taskCatalogColModel}</th>
            <th className="py-1 pr-3 font-medium">{m.taskCatalogColGrade}</th>
            <th className="py-1 pr-3 text-right font-medium">{m.taskCatalogColInput}</th>
            <th className="py-1 text-right font-medium">{m.taskCatalogColOutput}</th>
          </tr></thead>
          <tbody>{routes.map((route) => <tr key={route.workerName}
            data-testid="amux-task-cost-catalog-route" className="border-t border-zinc-800">
            <td className="py-1.5 pr-3">{route.workerName}</td>
            <td className="py-1.5 pr-3 font-mono text-xs">{route.modelId}</td>
            <td className="py-1.5 pr-3">{route.grade && route.grade in m.taskCatalogGrade ?
              m.taskCatalogGrade[route.grade as Grade] : "—"}</td>
            <td className="py-1.5 pr-3 text-right">{usd(route.inputUsdPerMillion)}</td>
            <td className="py-1.5 text-right">{usd(route.outputUsdPerMillion)}</td>
          </tr>)}</tbody>
        </table>
        <p className="mt-1 text-xs text-zinc-500">{m.taskCatalogPerMillion}</p>
      </div> : null}
      {skipped.length > 0 ? <div data-testid="amux-task-cost-catalog-skipped"
        className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
        <p className="text-xs font-semibold text-amber-300">{m.taskCatalogSkipped}</p>
        <ul className="space-y-0.5 text-xs">{skipped.map((worker) =>
          <li key={worker.workerName}>{worker.workerName} · <span className="font-mono">
            {worker.modelId}</span> — {m.taskCatalogSkipReason[worker.reason]}</li>)}</ul>
        {skipped.some((worker) => worker.reason === "price_missing") ?
          <Link href="/admin/models" className="text-xs underline">{m.taskCatalogModelsLink}</Link> : null}
      </div> : null}
    </div>

    <div className={stepClass}>
      <h4 className="font-semibold">{m.taskCatalogStepCaps}</h4>
      <p className="text-xs text-zinc-400">{m.taskCatalogStepCapsHint}</p>
      <div className="grid gap-2 sm:grid-cols-3">{GRADES.map((key) =>
        <fieldset key={key} className="space-y-1.5 rounded-md border border-zinc-800 p-2">
          <legend className="px-1 text-xs font-semibold">{m.taskCatalogGrade[key]}</legend>
          {([["inputTokens", m.taskCatalogInputTokens], ["outputTokens", m.taskCatalogOutputTokens],
            ["maxAttempts", m.taskCatalogMaxAttempts]] as const).map(([field, label]) =>
            <label key={field} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-zinc-400">{label}</span>
              <input type="number" inputMode="numeric" min={1} step={1}
                data-testid={`amux-task-cost-catalog-cap-${key}-${field}`}
                value={caps[key][field]} disabled={busy || unknown || approved}
                onChange={(event) => setCap(key, field, event.target.value)}
                className="min-h-9 w-28 rounded border border-zinc-600 bg-transparent px-2 text-right tabular-nums" />
            </label>)}
        </fieldset>)}</div>
      <button type="button" className={buttonClass} disabled={busy || unknown || approved}
        data-testid="amux-task-cost-catalog-calculate"
        onClick={() => { if (!unknown) void calculate(caps); }}>{m.taskCatalogCalculate}</button>
    </div>

    <div className={stepClass}>
      <h4 className="font-semibold">{m.taskCatalogStepCost}</h4>
      {draft && !stale ? <>
        <dl className="grid gap-2 sm:grid-cols-3">{GRADES.map((key) =>
          <div key={key} className="rounded-md bg-zinc-900 p-2">
            <dt className="text-xs text-zinc-400">{m.taskCatalogGrade[key]} · {m.taskCatalogMaxCost}</dt>
            <dd data-testid={`amux-task-cost-catalog-max-${key}`}
              className="text-lg font-semibold tabular-nums">
              {draft.maxCostMicroUsd[key] ? microUsd(draft.maxCostMicroUsd[key]) :
                <span className="text-xs font-normal text-zinc-500">{m.taskCatalogNoGradeWorker}</span>}</dd>
          </div>)}</dl>
        <p className="text-xs text-zinc-400">{m.taskCatalogPricesExpire(aest(draft.pricesExpireAt))}</p>
      </> : <p className="text-xs text-zinc-500">{m.taskCatalogCalculate}</p>}
    </div>

    <div className={stepClass}>
      <h4 className="font-semibold">{m.taskCatalogStepApprove}</h4>
      {draft && !stale ? <details className="text-xs">
        <summary className="cursor-pointer text-zinc-400">{m.taskCatalogShowJson}</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-zinc-900 p-2 font-mono">
          {JSON.stringify(draft.catalog, null, 2)}</pre>
      </details> : null}
      <label className="flex items-center gap-2"><input type="checkbox"
        data-testid="amux-task-cost-catalog-confirm" checked={confirmed}
        disabled={!draft || stale || busy || approved}
        onChange={(event) => setConfirmed(event.target.checked)} />
        {m.taskCatalogConfirm}</label>
      <button type="button" className={primaryButtonClass}
        data-testid="amux-task-cost-catalog-approve" onClick={() => void approve()}
        disabled={!approvalAvailable || !draft || stale || busy || unknown || approved || !confirmed}>
        {m.taskCatalogApprove}</button>
      {approvalId ? <p className="break-all text-xs">{m.taskCatalogApprovalId}: {approvalId}</p> : null}
      {unknown ? <p role="alert">{m.taskCatalogUnknown}</p> : null}
      {approved ? <p role="status" className="text-emerald-300">{m.taskCatalogApproved}</p> : null}
      {approvalId && (unknown || approved) ? <button type="button" className={buttonClass}
        onClick={() => void readBack()} disabled={busy}>{m.taskCatalogReadBack}</button> : null}
    </div>
    {reauth ? <a className="underline"
      href={adminRecentAuthenticationHref("/admin/amux-settings?tab=workers")}>
      {m.analysisResultReauth}</a> : null}
    {error ? <p role="alert" className="text-red-300">{error}</p> : null}
  </section>;
}
