"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminCommonMessages } from "@/lib/adminMessages/common";
import { adminAmuxMaxSubscriptionPriceMessages } from "@/lib/adminMessages/amuxMaxSubscriptionPrice";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { AMUX_IDEA_ANALYSIS_PROVIDER_LABELS } from "@/lib/amux/ideaAnalysisChannelCore";
import { readAvailableFrontierModels, type AvailableFrontierModel } from "@/lib/amux/ideaFrontierCatalogUiCore";

const endpoint = "/api/admin/amux/ideas/analysis-prices";
const modelsEndpoint = "/api/admin/amux/ideas/frontier-models?mode=available";

export type MaxSubscriptionPriceView = {
  profile: { inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number;
    inputTokensCap: number; outputTokensCap: number };
  latest: null | { id: string; version: number; status: string; expiresAt: string; admissible: boolean };
};

/** Reads one model's max-subscription profile reply; anything else, including
 * a reply for a different provider or model, is unreadable. */
export function readMaxSubscriptionPriceView(value: unknown,
  expected: { provider: string; modelId: string }): MaxSubscriptionPriceView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const profile = row.profile as Record<string, unknown> | undefined;
  if (row.state !== "profile" || !profile || typeof profile !== "object" ||
      profile.mode !== "subscription_cli" || profile.provider !== expected.provider ||
      profile.modelId !== expected.modelId ||
      !["inputMicroUsdPerMillion", "outputMicroUsdPerMillion", "inputTokensCap", "outputTokensCap"]
        .every((key) => Number.isSafeInteger(profile[key]))) return null;
  const view = { profile: {
    inputMicroUsdPerMillion: profile.inputMicroUsdPerMillion as number,
    outputMicroUsdPerMillion: profile.outputMicroUsdPerMillion as number,
    inputTokensCap: profile.inputTokensCap as number, outputTokensCap: profile.outputTokensCap as number } };
  if (row.latest === null) return { ...view, latest: null };
  const latest = row.latest as Record<string, unknown> | undefined;
  return latest && typeof latest === "object" && typeof latest.id === "string" &&
    Number.isSafeInteger(latest.version) && typeof latest.status === "string" &&
    typeof latest.expiresAt === "string" && typeof latest.admissible === "boolean"
    ? { ...view, latest: { id: latest.id, version: latest.version as number, status: latest.status,
      expiresAt: latest.expiresAt, admissible: latest.admissible } } : null;
}

const usd = (micro: number) => (micro / 1_000_000).toFixed(2);

/** amux-intake v19 (owner decision 2026-10-20): the owner approves one
 * subscription_cli price per approved Frontier model, on whichever of the four
 * CLI channels runs it. Every price is the reviewed Opus 5.5 profile as a
 * conservative estimate. A lost answer is read back by its ID and never sent
 * again. */
export function AmuxMaxSubscriptionPricePanel() {
  const m = useAdminMessages(adminAmuxMaxSubscriptionPriceMessages);
  const common = useAdminMessages(adminCommonMessages).apiFailure;
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [requiresReauthentication, setRequiresReauthentication] = useState(false);
  const onStatus = useCallback((status: number) => setRequiresReauthentication(status === 428), []);

  const loadModels = useCallback(async () => {
    const response = await adminFetch(modelsEndpoint, { cache: "no-store" });
    // A refused step-up is shown as the reauthentication link alone.
    if (response.status === 428) { setRequiresReauthentication(true); return; }
    const parsed = readAvailableFrontierModels(response.status,
      response.ok ? await response.json() : null);
    if (!parsed) throw new Error("models_unavailable");
    setModels(parsed); setModelsFailed(false);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { void loadModels().catch(() => { if (active) setModelsFailed(true); }); });
    return () => { active = false; };
  }, [loadModels]);

  return <section aria-labelledby="amux-max-subscription-price-title"
    className="space-y-3 rounded-lg border p-4 text-sm border-zinc-700">
    <h4 id="amux-max-subscription-price-title" className="font-semibold">{m.title}</h4>
    <p>{m.hint}</p>
    {modelsFailed || !models || models.length === 0
      ? <p role="status" data-testid="amux-max-subscription-price-models">
        {modelsFailed ? m.modelsUnavailable : !models ? m.loadingModels : m.noModels}</p>
      : <ul className="space-y-3">{models.map((model) => <li key={model.approvalId}>
        <SubscriptionPriceRow model={model} onStatus={onStatus} /></li>)}</ul>}
    <button type="button" onClick={() => void loadModels().catch(() => setModelsFailed(true))}
      className="min-h-11 rounded-lg border border-zinc-500 px-4">{m.refreshModels}</button>
    {requiresReauthentication ? <p role="alert"><Link
      href={adminRecentAuthenticationHref("/admin/amux-settings?tab=analysis")}
      className="inline-flex min-h-11 items-center rounded-lg border border-amber-500 px-4">
      {common.reauthenticate}</Link></p> : null}
  </section>;
}

function SubscriptionPriceRow({ model, onStatus }: {
  model: AvailableFrontierModel; onStatus: (status: number) => void;
}) {
  const m = useAdminMessages(adminAmuxMaxSubscriptionPriceMessages);
  const [view, setView] = useState<MaxSubscriptionPriceView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<"refused" | "saved" | null>(null);
  const { provider, modelId } = model;
  const rowId = `amux-subscription-price-${model.approvalId}`;

  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ profile: "max-subscription", provider, modelId });
    const response = await adminFetch(`${endpoint}?${query}`, { cache: "no-store" });
    onStatus(response.status);
    const parsed = response.ok
      ? readMaxSubscriptionPriceView(await response.json(), { provider, modelId }) : null;
    if (!parsed) throw new Error("price_unavailable");
    setView(parsed); setReadFailed(false);
  }, [provider, modelId, onStatus]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { void refresh().catch(() => { if (active) setReadFailed(true); }); });
    return () => { active = false; };
  }, [refresh]);

  const latest = view?.latest ?? null;
  const usable = latest?.status === "approved" && latest.admissible;
  const canApprove = !!view && !busy && !pendingId && confirmed && latest?.status !== "approved";
  const canRevoke = !!latest && latest.status === "approved" && !busy && !pendingId && revokeConfirmed;

  const settle = async (status: number) => {
    onStatus(status);
    setConfirmed(false); setRevokeConfirmed(false);
    await refresh().catch(() => setReadFailed(true));
  };
  const approve = async () => {
    if (!canApprove || !view) return;
    const id = crypto.randomUUID();
    setPendingId(id); setBusy(true); setNotice(null);
    try {
      const response = await adminFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, expectedPreviousVersion: latest?.version ?? 0,
          ownerConfirmedWorstTier: true, mode: "subscription_cli", provider, modelId }) });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 201 && (body as { priceVersionId?: unknown } | null)?.priceVersionId === id) {
        setPendingId(null); setNotice("saved"); await settle(response.status); return;
      }
      // 4xx answers come before the write: nothing was saved.
      if (response.status >= 400 && response.status < 500) {
        setPendingId(null); setNotice("refused"); await settle(response.status); return;
      }
    } catch { /* Unknown: keep the ID and only read it back. */ }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    if (!pendingId || busy) return;
    setBusy(true);
    try {
      const response = await adminFetch(`${endpoint}?${new URLSearchParams({ id: pendingId })}`, { cache: "no-store" });
      const body = response.ok ? await response.json() as { state?: unknown } : null;
      // Not visible yet may still be a commit in flight: only a found row ends
      // the unknown state. A reload drops the ID, and the version check then
      // refuses a second approval on the same predecessor.
      if (body?.state === "found") { setPendingId(null); setNotice("saved"); await settle(response.status); }
    } catch { /* Keep the same ID. */ }
    finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!canRevoke || !latest) return;
    setBusy(true); setNotice(null);
    try {
      const response = await adminFetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priceVersionId: latest.id, expectedVersion: latest.version }) });
      setNotice(response.ok ? "saved" : "refused");
      await settle(response.status);
    } catch { await refresh().catch(() => setReadFailed(true)); }
    finally { setBusy(false); }
  };

  return <section aria-labelledby={`${rowId}-title`}
    className="space-y-2 rounded-lg border p-3 border-zinc-700" data-testid="amux-subscription-price-row">
    <h5 id={`${rowId}-title`} className="font-semibold break-all">
      {AMUX_IDEA_ANALYSIS_PROVIDER_LABELS[provider]} / <span className="font-mono">{modelId}</span></h5>
    {view ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt>{m.rates}</dt><dd className="font-mono">
        {usd(view.profile.inputMicroUsdPerMillion)} / {usd(view.profile.outputMicroUsdPerMillion)}</dd>
      <dt>{m.caps}</dt><dd className="font-mono">
        {view.profile.inputTokensCap.toLocaleString()} / {view.profile.outputTokensCap.toLocaleString()}</dd>
      {latest ? <><dt>{m.version}</dt><dd>{latest.version}</dd>
        <dt>{m.expires}</dt><dd className="font-mono">{latest.expiresAt}</dd></> : null}
    </dl> : null}
    <p role="status" data-testid="amux-max-subscription-price-state">
      {readFailed ? m.unavailable : !view ? m.loading : !latest ? m.none
        : latest.status === "approved" ? (usable ? m.ready : m.unusable) : m.revoked}</p>
    {latest?.status !== "approved" ? <label className="flex items-center gap-2">
      <input type="checkbox" checked={confirmed} disabled={!view || busy || !!pendingId}
        onChange={(event) => setConfirmed(event.target.checked)} className="size-5" />{m.confirm}</label> : null}
    {latest?.status === "approved" ? <label className="flex items-center gap-2">
      <input type="checkbox" checked={revokeConfirmed} disabled={busy}
        onChange={(event) => setRevokeConfirmed(event.target.checked)} className="size-5" />{m.revokeConfirm}</label> : null}
    <div className="flex flex-wrap gap-2">
      {latest?.status !== "approved" ? <button type="button" onClick={() => void approve()} disabled={!canApprove}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.approve}</button> : null}
      {latest?.status === "approved" ? <button type="button" onClick={() => void revoke()}
        disabled={!canRevoke}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.revoke}</button> : null}
      <button type="button" disabled={busy} onClick={() => void refresh().catch(() => setReadFailed(true))}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.refresh}</button>
      {pendingId ? <button type="button" disabled={busy} onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.readBack}</button> : null}
    </div>
    {pendingId ? <p role="alert">{m.unknown} <span className="font-mono">{pendingId}</span></p> : null}
    {notice ? <p role={notice === "saved" ? "status" : "alert"}>{m[notice]}</p> : null}
  </section>;
}
