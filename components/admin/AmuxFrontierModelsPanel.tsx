"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { readAvailableFrontierModels, type AvailableFrontierModel } from "@/lib/amux/ideaFrontierCatalogUiCore";

export function AmuxFrontierModelsPanel({ available }: { available: boolean }) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [loading, setLoading] = useState(available);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

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
    void load();
  };

  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      aria-labelledby="amux-v4-frontier-models-heading">
      <h3 id="amux-v4-frontier-models-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">
        {m.frontierModelsTitle}
      </h3>
      <p className="text-zinc-700 dark:text-zinc-300">{m.frontierModelsHint}</p>
      {!available ? <p>{m.frontierModelsUnavailable}</p> : null}
      {available ? <button type="button" onClick={refresh} disabled={loading}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {m.frontierModelsRefresh}
      </button> : null}
      {loading ? <p role="status">{m.frontierModelsLoading}</p> : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {models?.length === 0 ? <p role="status">{m.frontierModelsEmpty}</p> : null}
      {models && models.length > 0 ? (
        <ul className="space-y-1" aria-label={m.frontierModelsTitle}>
          {models.map((model) => <li key={model.approvalId}
            className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <span className="font-medium">{model.provider} / {model.modelId}</span>
            <span className="ml-2 text-zinc-600 dark:text-zinc-400">
              {m.frontierModelsEfforts}: {model.allowedEfforts.join(", ")}
            </span>
          </li>)}
        </ul>
      ) : null}
    </section>
  );
}
