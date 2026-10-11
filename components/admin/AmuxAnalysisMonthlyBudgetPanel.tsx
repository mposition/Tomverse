"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminCommonMessages } from "@/lib/adminMessages/common";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAmuxAnalysisMonthlyBudgetMessages } from "@/lib/adminMessages/amuxAnalysisMonthlyBudget";
import { analysisBudgetUsdToMicroUsd, analysisBudgetMicroUsdToUsd,
  analysisBudgetSavedMatches, readAnalysisBudgetSnapshotReply,
  readPendingAnalysisBudgetSetting, type PendingAnalysisBudgetSetting } from "@/lib/amux/ideaAnalysisBudgetSettingCore";

const endpoint = "/api/admin/amux/ideas/analysis-budget-settings";
type Snapshot = NonNullable<ReturnType<typeof readAnalysisBudgetSnapshotReply>>;

export function AmuxAnalysisBudgetReauthenticationNotice() {
  const m = useAdminMessages(adminCommonMessages).apiFailure;
  return <p role="alert"><Link
    href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}
    className="inline-flex min-h-11 items-center rounded-lg border border-amber-500 px-4">
    {m.reauthenticate}
  </Link></p>;
}

export function AmuxAnalysisMonthlyBudgetPanel({ available, operatorId }: {
  available: boolean; operatorId: string;
}) {
  const m = useAdminMessages(adminAmuxAnalysisMonthlyBudgetMessages);
  const recoveryKey = `amux-analysis-monthly-budget:${operatorId}`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [monthlyUsd, setMonthlyUsd] = useState("1000");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [pending, setPending] = useState<PendingAnalysisBudgetSetting | null>(null);
  const [notice, setNotice] = useState<"unavailable" | "changed" | "below" | "refused" | "saved" | "storage" | null>(null);
  const [savedAuditId, setSavedAuditId] = useState<string | null>(null);
  const [requiresReauthentication, setRequiresReauthentication] = useState(false);

  const refresh = useCallback(async () => {
    const response = await adminFetch(endpoint, { cache: "no-store" });
    setRequiresReauthentication(response.status === 428);
    const parsed = response.ok ? readAnalysisBudgetSnapshotReply(await response.json()) : null;
    if (!parsed) throw new Error("budget_unavailable");
    setSnapshot(parsed);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = window.sessionStorage.getItem(recoveryKey);
        const restored = stored ? readPendingAnalysisBudgetSetting(JSON.parse(stored)) : null;
        if (stored && !restored) throw new Error("invalid_recovery");
        if (restored) { setPending(restored); setMonthlyUsd(restored.monthlyUsd); }
        const probe = `${recoveryKey}:probe`;
        window.sessionStorage.setItem(probe, "ok"); window.sessionStorage.removeItem(probe);
        setStorageReady(true);
      } catch { setNotice("storage"); }
      if (available) void refresh().catch(() => { if (active) setNotice("unavailable"); });
    });
    return () => { active = false; };
  }, [available, recoveryKey, refresh]);

  const amount = analysisBudgetUsdToMicroUsd(monthlyUsd);
  const invalid = amount === null;
  const below = !!snapshot && amount !== null && BigInt(amount) <
    BigInt(snapshot.spentMicroUsd) + BigInt(snapshot.reservedMicroUsd);
  const locked = !available || !snapshot?.writeEnabled || !storageReady || busy || !!pending;

  const clearPending = () => {
    window.sessionStorage.removeItem(recoveryKey);
    setPending(null); setConfirmed(false);
  };
  const save = async () => {
    if (locked || invalid || below || !confirmed || !snapshot) return;
    const attempt = { id: crypto.randomUUID(), expectedPreviousVersion: snapshot.version, monthlyUsd };
    // Durable before POST: a reload cannot create a second ambiguous decision.
    try { window.sessionStorage.setItem(recoveryKey, JSON.stringify(attempt)); }
    catch { setStorageReady(false); setNotice("storage"); return; }
    setPending(attempt); setBusy(true); setNotice(null);
    try {
      const response = await adminFetch(endpoint, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...attempt, ownerConfirmed: true }) });
      setRequiresReauthentication(response.status === 428);
      const body: unknown = await response.json();
      if (!response.ok) {
        const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
        if ([403, 409, 428, 429].includes(response.status) && ["forbidden", "invalid_budget",
          "revision_changed", "below_committed_cost", "budget_disabled",
          "ADMIN_REAUTHENTICATION_REQUIRED", "RATE_LIMIT_EXCEEDED"].includes(String(error))) {
          clearPending();
          if (error === "revision_changed" || error === "below_committed_cost") setSnapshot(null);
          setNotice(error === "revision_changed" ? "changed" : error === "below_committed_cost" ? "below" : "refused");
          return;
        }
        throw new Error("unknown_save");
      }
      if (!analysisBudgetSavedMatches(body, attempt)) throw new Error("unknown_save");
      clearPending(); setNotice("saved"); setSavedAuditId((body as { auditId: string }).auditId);
      setSnapshot(null);
      await refresh().catch(() => setNotice("unavailable"));
    } catch { /* Pending ID remains; only read-back is allowed. */ }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const response = await adminFetch(`${endpoint}?${new URLSearchParams({ id: pending.id })}`, { cache: "no-store" });
      setRequiresReauthentication(response.status === 428);
      const body: unknown = response.ok ? await response.json() : null;
      if (!analysisBudgetSavedMatches(body, pending)) return;
      clearPending(); setNotice("saved"); setSavedAuditId((body as { auditId: string }).auditId);
      setSnapshot(null);
      await refresh().catch(() => setNotice("unavailable"));
    } catch { /* Keep the same ID; never retry the write. */ }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="amux-analysis-monthly-budget-title"
    className="space-y-3 rounded-lg border border-zinc-300 p-4 text-sm dark:border-zinc-700">
    <h4 id="amux-analysis-monthly-budget-title" className="font-semibold">{m.title}</h4>
    <p>{m.hint}</p>
    {snapshot ? <dl className="grid grid-cols-2 gap-2">
      <dt>{m.month}</dt><dd>{snapshot.monthStart.slice(0, 7)}</dd>
      <dt>{m.current}</dt><dd>{analysisBudgetMicroUsdToUsd(snapshot.limitMicroUsd)}</dd>
      <dt>{m.spent}</dt><dd>{analysisBudgetMicroUsdToUsd(snapshot.spentMicroUsd)}</dd>
      <dt>{m.reserved}</dt><dd>{analysisBudgetMicroUsdToUsd(snapshot.reservedMicroUsd)}</dd>
      <dt>{m.remaining}</dt><dd>{analysisBudgetMicroUsdToUsd(snapshot.remainingMicroUsd)}</dd>
      <dt>{m.version}</dt><dd>{snapshot.version}</dd>
    </dl> : <p role="status">{available && !notice ? m.loading : m.unavailable}</p>}
    <p>{m.billing}</p>
    <label htmlFor="amux-analysis-monthly-usd" className="flex flex-col gap-1">{m.limit}
      <input id="amux-analysis-monthly-usd" type="text" inputMode="decimal" value={monthlyUsd}
        maxLength={16} disabled={locked} aria-describedby="amux-analysis-monthly-hint amux-analysis-monthly-error"
        aria-invalid={invalid || below} onChange={(e) => { setMonthlyUsd(e.target.value); setConfirmed(false); setNotice(null); }}
        className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900" />
    </label>
    <p id="amux-analysis-monthly-hint">{m.inputHint}</p>
    <p id="amux-analysis-monthly-error" role="alert">{invalid ? m.invalid : below ? m.below : null}</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} disabled={locked}
      onChange={(e) => setConfirmed(e.target.checked)} />{m.confirm}</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => void save()} disabled={locked || invalid || below || !confirmed}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.save}</button>
      <button type="button" onClick={() => { setBusy(true); setConfirmed(false); void refresh()
        .then(() => setNotice(null)).catch(() => setNotice("unavailable")).finally(() => setBusy(false)); }}
        disabled={!available || busy} className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.refresh}</button>
      {pending ? <button type="button" disabled={busy} onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.readBack}</button> : null}
    </div>
    {pending ? <p role="alert">{m.unknown} <span className="font-mono">{pending.id}</span></p> : null}
    {notice ? <p role={notice === "saved" ? "status" : "alert"}>{m[notice]}</p> : null}
    {requiresReauthentication ? <AmuxAnalysisBudgetReauthenticationNotice /> : null}
    {savedAuditId ? <p>{m.audit}: <span className="font-mono">{savedAuditId}</span></p> : null}
    {busy ? <p role="status">{m.loading}</p> : null}
  </section>;
}
