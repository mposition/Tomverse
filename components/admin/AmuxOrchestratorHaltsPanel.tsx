"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from "lucide-react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxOrchestratorHaltsMessages } from "@/lib/adminMessages/amuxOrchestratorHalts";
import { AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH, AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS, amuxOrchestratorHaltReasonAllowsAutoClear } from "@/lib/amux/orchestratorHaltCore";
import type { AmuxOrchestratorAdminHalt, AmuxOrchestratorAdminView, AmuxOrchestratorAdminWrite } from "@/lib/amux/orchestratorHaltStore";
import type { AdminLocale, AdminMessageShape } from "@/lib/adminLocale";

const CLEAR_PATH = "/api/admin/amux/orchestrator-halts";
const RETURN_TO = "/admin/amux-settings?tab=safety";
const muted = "text-zinc-400";
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
type Messages = AdminMessageShape<typeof adminAmuxOrchestratorHaltsMessages.en>;
type Limits = { open: number; cleared: number; human: number };
export type HaltAttention = "automatic_pending" | "operator_required" | "cause_required";

/** Presentation only; the server and database decide whether a halt is cleared. */
export function amuxHaltAttention(halt: AmuxOrchestratorAdminHalt): HaltAttention {
  if (halt.reasonCode === "contract_violation" || halt.reasonCode === "selection_read_failures") return "cause_required";
  if (amuxOrchestratorHaltReasonAllowsAutoClear(halt.reasonCode)
    && halt.requestId !== null && halt.write?.requestId === halt.requestId
    && halt.write.receiptCount === 0 && halt.write.resolution === null && halt.write.resolvedAt === null
    && halt.write.ackedAt === null) return "automatic_pending";
  return "operator_required";
}
export function amuxHaltHasAutomaticEvidence(halt: AmuxOrchestratorAdminHalt): boolean {
  return halt.clearKind === "system_no_commit" && halt.clearedAt !== null
    && halt.requestId !== null && halt.write?.requestId === halt.requestId
    && halt.write.resolution === "no_commit" && halt.write.receiptCount === 0
    && typeof halt.clearAuditLogId === "string" && halt.clearAuditLogId.length > 0
    && typeof halt.clearEvidenceAuditLogId === "string" && halt.clearEvidenceAuditLogId.length > 0;
}
export const amuxHaltClearReady = (prefix: string, checks: readonly boolean[]) =>
  prefix.trim().length === AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH && checks.length === 3 && checks.every(Boolean);

export function AmuxOrchestratorHaltsPanel(props: { view: AmuxOrchestratorAdminView | null; canClear: boolean; limits: Limits }) {
  const m = useAdminMessages(adminAmuxOrchestratorHaltsMessages);
  const { locale } = useAdminLocale();
  const router = useRouter();
  return AmuxOrchestratorHaltsView({ ...props, m, locale, onRefresh: () => router.refresh() });
}

export function AmuxOrchestratorHaltsView({ view, canClear, limits, m, locale, onRefresh }: {
  view: AmuxOrchestratorAdminView | null; canClear: boolean; limits: Limits;
  m: Messages; locale: AdminLocale; onRefresh: () => void;
}) {
  const blocked = view !== null && (view.openCount > 0 || view.humanRequiredCount > 0);
  return <section className="flex min-w-0 flex-col gap-6 text-sm leading-6 text-zinc-100" data-testid="amux-orchestrator-halts-panel">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{m.title}</h2><p className={`mt-1 ${muted}`}>{m.description}</p></div>
      <Link className={`inline-flex min-h-11 items-center text-blue-300 underline underline-offset-4 ${focus}`} href="/admin/amux-execution">{m.executionLink}</Link></div>
    <div role={view === null ? "alert" : "status"} data-testid="amux-halt-status" className={`flex items-start gap-3 rounded-lg border p-4 ${view === null ? "border-red-800 bg-red-950/50 text-red-200" : blocked ? "border-amber-800 bg-amber-950/50 text-amber-200" : "border-status-success-900 bg-status-success-950/50 text-status-success-200"}`}>
      {view === null || blocked ? <AlertTriangle aria-hidden className="mt-1 size-5 shrink-0" /> : <CheckCircle2 aria-hidden className="mt-1 size-5 shrink-0" />}
      <div className="min-w-0"><h3 className="text-base font-semibold">{view === null ? m.unavailableTitle : blocked ? m.blockedTitle : m.quietTitle}</h3><p className="mt-1">{view === null ? m.unavailableBody : blocked ? m.blockedBody : m.quietBody}</p>
        {view === null ? <button className={`mt-2 inline-flex min-h-11 items-center gap-2 underline ${focus}`} onClick={onRefresh}><RefreshCw aria-hidden className="size-4" />{m.refresh}</button> : null}</div></div>
    <div><h3 className="font-semibold">{m.automaticTitle}</h3><p className={`mt-1 max-w-prose ${muted}`}>{m.automaticBody}</p></div>
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"><div className="min-w-0 space-y-4">
      {view ? <><div><h3 className="text-lg font-semibold">{m.openTitle}</h3><p className={`mt-1 ${muted}`} data-testid="amux-halts-open-count">{m.openShown(view.open.length, view.openCount, limits.open)}</p></div>
        {view.open.length === 0 ? <p className={muted}>{m.noOpen}</p> : view.open.map(halt => HaltCard({ halt, m, locale, canClear, showCleared: false }))}</> : null}</div>
      <aside className="h-fit rounded-lg border border-zinc-800 bg-zinc-900 p-5" aria-labelledby="amux-halt-guide"><h3 id="amux-halt-guide" className="text-base font-semibold">{m.guideTitle}</h3>
        <dl className="mt-4 space-y-5">{m.guide.map((item, index) => <div key={item.title}><dt className={`font-semibold ${index === 0 ? "text-status-success-300" : index === 2 ? "text-amber-300" : ""}`}>{item.title}</dt><dd className={`mt-1 ${muted}`}>{item.body}</dd></div>)}</dl>
        {view?.humanRequiredCount ? <a href="#amux-halts-writes" className={`mt-3 inline-flex min-h-11 items-center text-blue-300 underline ${focus}`}>{m.humanTitle}</a> : null}</aside></div>
    {view ? <><section id="amux-halts-writes" className="min-w-0 space-y-3" aria-label={m.humanTitle}><h3 className="text-lg font-semibold">{m.humanTitle}</h3>
      <p className={muted} data-testid="amux-halts-human-count">{m.humanShown(view.humanRequired.length, view.humanRequiredCount, limits.human)}</p>
      {view.humanRequired.length === 0 ? <p className={muted}>{m.noHuman}</p> : <ul className="space-y-4" data-testid="amux-halts-human-list">{view.humanRequired.map(write => <li key={write.requestId} className="rounded-lg border border-zinc-800 p-4">{WriteSummary({ write, m, locale })}</li>)}</ul>}</section>
      <section className="min-w-0 space-y-3" aria-label={m.clearedTitle}><h3 className="text-lg font-semibold">{m.clearedTitle}</h3><p className={muted}>{m.clearedShown(view.cleared.length, view.clearedCount, limits.cleared)}</p>
        {view.cleared.length === 0 ? <p className={muted}>{m.noCleared}</p> : <ul className="space-y-3">{view.cleared.map(halt => <li key={halt.haltId}>{HaltCard({ halt, m, locale, canClear: false, showCleared: true })}</li>)}</ul>}</section></> : null}
  </section>;
}

function DateValue({ value, locale }: { value: string; locale: AdminLocale }) {
  const date = new Date(value);
  const text = Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" }).format(date);
  return <time dateTime={value}>{text} (Brisbane)</time>;
}

function HaltCard({ halt, canClear, showCleared, m, locale }: { halt: AmuxOrchestratorAdminHalt; canClear: boolean; showCleared: boolean; m: Messages; locale: AdminLocale }) {
  const attention = amuxHaltAttention(halt);
  const automatic = amuxHaltHasAutomaticEvidence(halt);
  const incompleteClear = !showCleared && amuxOrchestratorHaltReasonAllowsAutoClear(halt.reasonCode)
    && halt.requestId !== null && halt.write?.requestId === halt.requestId
    && halt.write.resolution === "no_commit" && halt.write.receiptCount === 0 && halt.write.ackedAt === null;
  return <article key={halt.haltId} className="min-w-0 rounded-lg border border-zinc-800 p-4" data-testid="amux-halt-row" data-attention={showCleared ? "cleared" : attention}>
    <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-semibold">{m.reasonLabels[halt.reasonCode]}</h4><span className={`inline-flex items-center gap-1 text-xs font-semibold ${automatic ? "text-status-success-300" : "text-amber-300"}`}>
      {automatic ? <CheckCircle2 className="size-4" aria-hidden /> : attention === "automatic_pending" ? <Clock3 className="size-4" aria-hidden /> : <AlertTriangle className="size-4" aria-hidden />}
      {showCleared ? automatic ? m.autoCleared : halt.clearKind === "human" ? m.humanCleared : m.clearKindUnknown : m.category[attention]}</span></div>
    <p className={`mt-2 ${muted}`}>{showCleared ? m.clearConsequence : incompleteClear ? m.autoClearIncomplete : m.categoryDetail[attention]}</p>
    <dl className="mt-4 grid min-w-0 gap-x-4 gap-y-2 rounded-md bg-zinc-900 p-3 sm:grid-cols-[auto_minmax(0,1fr)]"><dt className={muted}>{m.admission}</dt><dd>{halt.write ? m.admissionPresent : m.admissionMissing}</dd><dt className={muted}>{showCleared ? m.clearedAt : m.openedAt}</dt><dd><DateValue value={showCleared ? halt.clearedAt ?? halt.openedAt : halt.openedAt} locale={locale} /></dd>
      {showCleared ? <><dt className={muted}>{m.actor}</dt><dd className="break-all">{automatic ? m.autoCleared : halt.clearedByUserId ?? m.none}</dd></> : null}</dl>
    {halt.write ? WriteSummary({ write: halt.write, m, locale }) : null}
    <details className="mt-3 min-w-0"><summary className={`min-h-11 cursor-pointer py-2 font-medium ${focus}`}>{m.reason} · <code className="break-all font-mono text-xs">{halt.reasonCode}</code></summary><dl className="grid gap-1 break-all text-xs sm:grid-cols-[auto_minmax(0,1fr)]"><dt>{m.haltId}</dt><dd className="font-mono">{halt.haltId}</dd><dt>{m.haltKey}</dt><dd className="font-mono">{halt.haltKey}</dd><dt>{m.request}</dt><dd className="font-mono">{halt.requestId ?? m.none}</dd>
      {showCleared ? <><dt>{m.audit}</dt><dd className="font-mono">{halt.clearAuditLogId ?? m.none}</dd><dt>{m.evidenceAudit}</dt><dd className="font-mono">{halt.clearEvidenceAuditLogId ?? m.none}</dd></> : null}</dl></details>
    {!showCleared && attention !== "automatic_pending" ? canClear ? <ClearHaltForm haltId={halt.haltId} /> : <p className={`mt-3 ${muted}`}>{m.clearOwnerOnly}</p> : null}
  </article>;
}

function WriteSummary({ write, m, locale }: { write: AmuxOrchestratorAdminWrite; m: Messages; locale: AdminLocale }) {
  return <div className="mt-3 min-w-0 space-y-2 text-sm"><p className="font-medium">{m.write(write.callKind, write.receiptCount)}</p><p className={muted}>{write.resolvedAt && write.resolution ? m.writeClosed(write.resolution, write.resolvedAt) : write.ackedAt ? m.writeAcked(write.ackedAt) : m.writeUnsettled}</p>
    <details><summary className={`min-h-11 cursor-pointer py-2 ${focus}`}>{m.request}</summary><p className="break-all font-mono text-xs">{write.requestId}</p><p className={`break-words ${muted}`}>{m.writeTimes(write.admittedAt, write.deadlineAt)}</p></details>
    {write.receipts.length > 0 ? <div><h5 className="font-medium">{m.receiptsTitle}</h5><p className={muted}>{m.receiptsShown(write.receipts.length, write.receiptCount)}</p><ul className="mt-2 space-y-2" data-testid="amux-halt-receipts">{write.receipts.map((receipt, index) => {
      const href = AMUX_ORCHESTRATOR_RECEIPT_TARGET_HREFS[receipt.targetKind];
      return <li key={`${receipt.targetKind}-${receipt.targetId ?? "batch"}-${index}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><span>{m.receipt(receipt.targetKind, receipt.rowCount)}</span><span className="break-all font-mono text-xs">{receipt.targetId ?? m.none}</span><DateValue value={receipt.committedAt} locale={locale} />{href ? <Link className={`inline-flex min-h-11 items-center text-blue-300 underline underline-offset-4 ${focus}`} href={href} data-testid="amux-halt-receipt-link">{m.receiptLink}</Link> : null}</li>;
    })}</ul></div> : null}</div>;
}

type ClearRefusal = "not_found" | "already_cleared" | "halt_key_mismatch";
const isClearRefusal = (value: unknown): value is ClearRefusal => value === "not_found" || value === "already_cleared" || value === "halt_key_mismatch";
function ClearHaltForm({ haltId }: { haltId: string }) {
  const m = useAdminMessages(adminAmuxOrchestratorHaltsMessages);
  const { locale } = useAdminLocale();
  const router = useRouter();
  const [prefix, setPrefix] = useState("");
  const [checks, setChecks] = useState([false, false, false]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [refusal, setRefusal] = useState<ClearRefusal | null>(null);
  const [done, setDone] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const inputId = `amux-halt-clear-${haltId}`;
  const clear = async () => {
    if (pending || unknown || !amuxHaltClearReady(prefix, checks)) return;
    setPending(true); setFailure(null); setRefusal(null);
    try {
      const response = await adminFetch(CLEAR_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ haltId, haltKeyPrefix: prefix.trim() }) });
      if (response.ok) {
        const result = await response.json().catch(() => null) as { cleared?: unknown; haltId?: unknown } | null;
        if (result?.cleared === true && result.haltId === haltId) { setDone(true); router.refresh(); return; }
        setUnknown(true); return;
      }
      if (response.status === 409 || response.status === 404) { const body = await response.clone().json().catch(() => null) as { error?: unknown } | null; if (isClearRefusal(body?.error)) { setRefusal(body.error); return; } }
      if (response.status >= 500) setUnknown(true);
      setFailure(await readAdminApiFailure(response, { fallback: m.clearFailed, locale }));
    } catch { setUnknown(true); setFailure(adminNetworkFailure(locale)); }
    finally { setPending(false); }
  };
  if (done) return <p role="status" className="mt-3 text-status-success-300" data-testid="amux-halt-cleared">{m.cleared}</p>;
  return <form className="mt-4 space-y-3 border-t border-zinc-800 pt-4" onSubmit={event => { event.preventDefault(); void clear(); }}>
    <fieldset disabled={pending || unknown}><legend className="font-semibold">{m.checkTitle}</legend><div className="mt-2 space-y-1">{m.checks.map((check, index) => <label key={check} className="flex min-h-11 cursor-pointer items-start gap-3 rounded py-2"><input type="checkbox" className={`mt-1 size-4 shrink-0 accent-blue-600 ${focus}`} checked={checks[index]} onChange={event => setChecks(current => current.map((value, i) => i === index ? event.target.checked : value))} /><span>{check}</span></label>)}</div></fieldset>
    <label className="flex flex-col gap-1 font-medium" htmlFor={inputId}>{m.clearLabel}<input id={inputId} className={`min-h-11 w-full max-w-xs rounded-md border border-zinc-600 bg-zinc-950 px-3 font-mono text-base ${focus}`} value={prefix} maxLength={AMUX_ORCHESTRATOR_HALT_KEY_PREFIX_LENGTH} autoComplete="off" spellCheck={false} disabled={pending || unknown} onChange={event => setPrefix(event.target.value)} data-testid="amux-halt-clear-prefix" aria-describedby={`${inputId}-help`} /></label>
    <p id={`${inputId}-help`} className={`text-xs ${muted}`}>{m.clearRequirements}</p>
    <button type="submit" className={`inline-flex min-h-11 items-center rounded-md bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 ${focus}`} disabled={pending || unknown || !amuxHaltClearReady(prefix, checks)} data-testid="amux-halt-clear">{pending ? m.clearing : m.clear}</button><p className={muted}>{m.clearConsequence}</p>
    {unknown ? <><p role="alert" className="text-amber-300">{m.unknownClear}</p><button type="button" onClick={() => window.location.reload()} className={`inline-flex min-h-11 items-center underline ${focus}`}>{m.refresh}</button></> : null}
    {refusal ? <p role="alert" className="text-red-300">{m.clearRefusals[refusal]}</p> : null}
    {failure ? <AdminApiFailureNotice failure={failure} returnTo={RETURN_TO} /> : null}
  </form>;
}
