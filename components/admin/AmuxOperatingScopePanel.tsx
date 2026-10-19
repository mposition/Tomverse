"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminCommonMessages } from "@/lib/adminMessages/common";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAmuxOperatingScopeMessages } from "@/lib/adminMessages/amuxOperatingScope";
import { readAvailableFrontierModels, type AvailableFrontierModel } from "@/lib/amux/ideaFrontierCatalogUiCore";
import {
  amuxOperatingScopeSavedMatches, classifyAmuxOperatingScopeSaveAnswer, normalizeAmuxOperatingScope, readAmuxOperatingScopeReply,
  readPendingAmuxOperatingScope, type AmuxOperatingScopeReply, type PendingAmuxOperatingScope,
} from "@/lib/amux/ideaOperatingScopeCore";

const endpoint = "/api/admin/amux/ideas/operating-scope";
type Notice = "unavailable" | "invalid" | "changed" | "notApproved" | "refused" | "saved" | "storage";

/**
 * docs/policy/amux-intake.md v19 item 2: the owner's operating scope, the one
 * approval for unattended intake. A save is recorded in sessionStorage before
 * it is sent, so a lost answer can only be read back by the same ID.
 */
export function AmuxOperatingScopePanel({ operatorId }: { operatorId: string }) {
  const m = useAdminMessages(adminAmuxOperatingScopeMessages);
  const common = useAdminMessages(adminCommonMessages).apiFailure;
  const recoveryKey = `amux-intake-operating-scope:${operatorId}`;
  const [current, setCurrent] = useState<AmuxOperatingScopeReply | null>(null);
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [repositories, setRepositories] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [effort, setEffort] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [pending, setPending] = useState<PendingAmuxOperatingScope | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savedAuditId, setSavedAuditId] = useState<string | null>(null);
  const [requiresReauthentication, setRequiresReauthentication] = useState(false);

  const refresh = useCallback(async () => {
    const [scopeResponse, modelResponse] = await Promise.all([
      adminFetch(endpoint, { cache: "no-store" }),
      adminFetch("/api/admin/amux/ideas/frontier-models?mode=available", { cache: "no-store" }),
    ]);
    setRequiresReauthentication(scopeResponse.status === 428);
    const reply = scopeResponse.ok ? readAmuxOperatingScopeReply(await scopeResponse.json()) : null;
    if (!reply) throw new Error("scope_unavailable");
    setCurrent(reply);
    setModels(readAvailableFrontierModels(modelResponse.status, modelResponse.ok ? await modelResponse.json() : null) ?? []);
    if (reply.state === "current") {
      setRepositories(reply.scope.repositories.join("\n"));
      setModelKey(`${reply.scope.model.provider}:${reply.scope.model.modelId}`);
      setEffort(reply.scope.model.reasoningEffort);
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = window.sessionStorage.getItem(recoveryKey);
        const restored = stored ? readPendingAmuxOperatingScope(JSON.parse(stored)) : null;
        if (stored && !restored) throw new Error("invalid_recovery");
        if (restored) setPending(restored);
        const probe = `${recoveryKey}:probe`;
        window.sessionStorage.setItem(probe, "ok"); window.sessionStorage.removeItem(probe);
        setStorageReady(true);
      } catch { setNotice("storage"); }
      void refresh().catch(() => { if (active) setNotice("unavailable"); });
    });
    return () => { active = false; };
  }, [recoveryKey, refresh]);

  const chosen = models?.find((model) => `${model.provider}:${model.modelId}` === modelKey) ?? null;
  const proposed = normalizeAmuxOperatingScope({
    repositories: repositories.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
    model: chosen ? { provider: chosen.provider, modelId: chosen.modelId, reasoningEffort: effort } : null,
  });
  const repositoriesInvalid = !proposed.ok &&
    (proposed.code === "repositories_invalid" || proposed.code === "repository_duplicate");
  const locked = !current || !storageReady || busy || !!pending;
  const canSave = !locked && proposed.ok && confirmed && !!chosen && chosen.allowedEfforts.includes(effort);

  const clearPending = () => {
    window.sessionStorage.removeItem(recoveryKey);
    setPending(null); setConfirmed(false);
  };
  const settleSaved = async (body: unknown) => {
    clearPending(); setNotice("saved"); setSavedAuditId((body as { auditId: string }).auditId);
    await refresh().catch(() => setNotice("unavailable"));
  };
  const save = async () => {
    if (!canSave || !current || !proposed.ok) return;
    const attempt: PendingAmuxOperatingScope = { id: crypto.randomUUID(),
      expectedPreviousVersion: current.version, scope: proposed.scope };
    // Durable before POST: a reload cannot create a second ambiguous decision.
    try { window.sessionStorage.setItem(recoveryKey, JSON.stringify(attempt)); }
    catch { setStorageReady(false); setNotice("storage"); return; }
    setPending(attempt); setBusy(true); setNotice(null);
    try {
      const response = await adminFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...attempt, ownerConfirmed: true }) });
      setRequiresReauthentication(response.status === 428);
      const body: unknown = await response.json().catch(() => null);
      const answer = classifyAmuxOperatingScopeSaveAnswer(response.status, body, attempt);
      if (answer.kind === "saved") { await settleSaved(body); return; }
      if (answer.kind === "refused") {
        // Known to come before the write: nothing was saved, so the pending ID is released.
        clearPending(); setNotice(answer.notice);
        if (answer.notice === "changed") await refresh().catch(() => setNotice("unavailable"));
        return;
      }
      throw new Error("unknown_save");
    } catch { /* The pending ID remains; only read-back is allowed. */ }
    finally { setBusy(false); }
  };
  const readBack = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const response = await adminFetch(`${endpoint}?${new URLSearchParams({ id: pending.id })}`, { cache: "no-store" });
      setRequiresReauthentication(response.status === 428);
      const body: unknown = response.ok ? await response.json() : null;
      if (amuxOperatingScopeSavedMatches(body, pending)) await settleSaved(body);
    } catch { /* Keep the same ID; never retry the write. */ }
    finally { setBusy(false); }
  };

  return <section aria-labelledby="amux-operating-scope-title"
    className="space-y-3 rounded-lg border p-4 text-sm border-zinc-700">
    <h4 id="amux-operating-scope-title" className="font-semibold">{m.title}</h4>
    <p>{m.hint}</p>
    {current?.state === "current" ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt>{m.version}</dt><dd>{current.version}</dd>
      <dt>{m.model}</dt><dd className="font-mono">{current.scope.model.modelId} · {current.scope.model.reasoningEffort}</dd>
      <dt>{m.repositories}</dt><dd className="font-mono">{current.scope.repositories.join(", ")}</dd>
    </dl> : current?.state === "none" ? <p role="status">{m.none}</p>
      : <p role="status">{notice === "unavailable" ? m.unavailable : m.loading}</p>}
    <label htmlFor="amux-operating-scope-repositories" className="flex flex-col gap-1">{m.repositories}
      <textarea id="amux-operating-scope-repositories" value={repositories} rows={4} disabled={locked}
        aria-describedby="amux-operating-scope-repositories-hint amux-operating-scope-error"
        aria-invalid={repositoriesInvalid}
        onChange={(event) => { setRepositories(event.target.value); setConfirmed(false); setNotice(null); }}
        className="rounded-lg border px-3 py-2 font-mono border-zinc-600 bg-zinc-900" />
    </label>
    <p id="amux-operating-scope-repositories-hint">{m.repositoriesHint}</p>
    <p id="amux-operating-scope-error" role="alert">{repositoriesInvalid && repositories.trim() ? m.invalid : null}</p>
    {models && models.length === 0 ? <p role="status">{m.noModels}</p> : null}
    <div className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-1">{m.model}
        <select value={modelKey} disabled={locked || !models?.length}
          onChange={(event) => { setModelKey(event.target.value); setEffort(""); setConfirmed(false); }}
          className="min-h-11 rounded-lg border px-3 border-zinc-600 bg-zinc-900">
          <option value="">—</option>
          {models?.map((model) => <option key={model.approvalId} value={`${model.provider}:${model.modelId}`}>
            {model.modelId}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">{m.effort}
        <select value={effort} disabled={locked || !chosen}
          onChange={(event) => { setEffort(event.target.value); setConfirmed(false); }}
          className="min-h-11 rounded-lg border px-3 border-zinc-600 bg-zinc-900">
          <option value="">—</option>
          {chosen?.allowedEfforts.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={confirmed} disabled={locked}
      onChange={(event) => setConfirmed(event.target.checked)} className="size-5" />{m.confirm}</label>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => void save()} disabled={!canSave}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.save}</button>
      <button type="button" disabled={busy} onClick={() => { setBusy(true); setConfirmed(false); void refresh()
        .then(() => setNotice(null)).catch(() => setNotice("unavailable")).finally(() => setBusy(false)); }}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.refresh}</button>
      {pending ? <button type="button" disabled={busy} onClick={() => void readBack()}
        className="min-h-11 rounded-lg border border-zinc-500 px-4 disabled:opacity-50">{m.readBack}</button> : null}
    </div>
    {pending ? <p role="alert">{m.unknown} <span className="font-mono">{pending.id}</span></p> : null}
    {notice && notice !== "unavailable" ? <p role={notice === "saved" ? "status" : "alert"}>{m[notice]}</p> : null}
    {requiresReauthentication ? <p role="alert"><Link
      href={adminRecentAuthenticationHref("/admin/amux-settings?tab=analysis")}
      className="inline-flex min-h-11 items-center rounded-lg border border-amber-500 px-4">
      {common.reauthenticate}</Link></p> : null}
    {savedAuditId ? <p>{m.audit}: <span className="font-mono">{savedAuditId}</span></p> : null}
  </section>;
}
