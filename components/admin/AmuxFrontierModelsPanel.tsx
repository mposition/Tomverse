"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  readAvailableFrontierModels,
  readCheckedFrontierSelection,
  type AvailableFrontierModel,
} from "@/lib/amux/ideaFrontierCatalogUiCore";

export function AmuxFrontierModelsPanel({ available }: { available: boolean }) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [loading, setLoading] = useState(available);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const selected = models?.find((model) => model.approvalId === selectedApprovalId);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!available) return;
    try {
      const response = await adminFetch("/api/admin/amux/ideas/frontier-models?mode=available",
        { cache: "no-store", signal });
      if (!response.ok) {
        const reason = await readAdminApiFailure(response, { fallback: m.frontierModelsUnavailable, locale });
        if (!signal?.aborted) { setModels(null); setFailure(reason); }
        return;
      }
      const parsed = readAvailableFrontierModels(response.status, await response.json());
      if (!signal?.aborted) {
        if (parsed === null) {
          setModels(null);
          setFailure({ message: m.frontierModelsInvalid, tone: "error",
            requiresReauthentication: false, approvalId: null });
        } else { setFailure(null); setModels(parsed); }
      }
    } catch {
      if (!signal?.aborted) {
        setModels(null);
        setFailure({ message: m.frontierModelsUnavailable, tone: "error",
          requiresReauthentication: false, approvalId: null });
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [available, locale, m.frontierModelsUnavailable, m.frontierModelsInvalid]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  const refresh = () => {
    setLoading(true);
    setFailure(null);
    setModels(null);
    setSelectedApprovalId("");
    setSelectedEffort("");
    setChecked(false);
    void load();
  };

  const checkSelection = async () => {
    if (!selected || !selected.allowedEfforts.includes(selectedEffort) || checking) return;
    setChecking(true);
    setChecked(false);
    setFailure(null);
    try {
      const params = new URLSearchParams({ mode: "check", provider: selected.provider,
        modelId: selected.modelId, reasoningEffort: selectedEffort });
      const response = await adminFetch(`/api/admin/amux/ideas/frontier-models?${params}`,
        { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, {
          fallback: m.frontierSelectionUnavailable, locale,
        }));
        return;
      }
      const result = readCheckedFrontierSelection(response.status, await response.json(), selected);
      if (!result) {
        setFailure({ message: m.frontierModelsInvalid, tone: "error",
          requiresReauthentication: false, approvalId: null });
        return;
      }
      setChecked(true);
    } catch {
      setFailure({ message: m.frontierSelectionUnavailable, tone: "error",
        requiresReauthentication: false, approvalId: null });
    } finally { setChecking(false); }
  };

  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      aria-labelledby="amux-v4-frontier-models-heading">
      <h3 id="amux-v4-frontier-models-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">
        {m.frontierModelsTitle}
      </h3>
      <p className="text-zinc-700 dark:text-zinc-300">{m.frontierModelsHint}</p>
      {!available ? <p>{m.frontierModelsUnavailable}</p> : null}
      {available ? <button type="button" onClick={refresh} disabled={loading || checking}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {m.frontierModelsRefresh}
      </button> : null}
      {loading ? <p role="status">{m.frontierModelsLoading}</p> : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {models?.length === 0 ? <p role="status">{m.frontierModelsEmpty}</p> : null}
      {models && models.length > 0 ? (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            {m.frontierSelectionModel}
            <select value={selectedApprovalId} disabled={checking}
              onChange={(event) => { setSelectedApprovalId(event.target.value); setSelectedEffort(""); setChecked(false); }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="">{m.frontierSelectionChoose}</option>
              {models.map((model) => <option key={model.approvalId} value={model.approvalId}>
                {model.provider} / {model.modelId}
              </option>)}
            </select>
          </label>
          {selected ? <label className="flex flex-col gap-1">
            {m.frontierModelsEfforts}
            <select value={selectedEffort} disabled={checking}
              onChange={(event) => { setSelectedEffort(event.target.value); setChecked(false); }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="">{m.frontierSelectionChoose}</option>
              {selected.allowedEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label> : null}
          <button type="button" onClick={() => void checkSelection()}
            disabled={!selected || !selectedEffort || checking}
            className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
            {m.frontierSelectionCheck}
          </button>
          {checked ? <p role="status">{m.frontierSelectionCurrent}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
