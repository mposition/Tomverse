"use client";

import { useMemo, useState } from "react";
import { Loader2, Search, ShieldAlert } from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { dispatchAppToast } from "@/lib/appToast";
import { getModelUsageProfile, type AiModel } from "@/lib/models";
import type { AdminModelOverrideStatus } from "@/lib/modelOverrides";

type ModelOverrideRow = {
  modelId: string;
  status: AdminModelOverrideStatus;
  reason: string | null;
  visibleNote: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
};

type Props = {
  models: readonly AiModel[];
  overrides: ModelOverrideRow[];
};

const statusOptions: Array<{ value: AdminModelOverrideStatus; label: string }> = [
  { value: "available", label: "Available" },
  { value: "limited", label: "Limited" },
  { value: "disabled", label: "Disabled" },
  { value: "coming-soon", label: "Coming soon" },
];

const statusClass = (status: AdminModelOverrideStatus) => {
  if (status === "disabled") return "border-red-500/30 bg-red-500/10 text-red-200";
  if (status === "limited") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (status === "coming-soon") return "border-purple-500/30 bg-purple-500/10 text-purple-200";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
};

const dateLabel = (value: string | null | undefined) => {
  if (!value) return "No override";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No override";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function ModelOverridesPanel({ models, overrides }: Props) {
  const [items, setItems] = useState(overrides);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<ModelOverrideRow>>>({});

  const overrideMap = useMemo(
    () => new Map(items.map((item) => [item.modelId, item])),
    [items]
  );
  const providers = useMemo(
    () => Array.from(new Set(models.map((model) => model.provider))).sort(),
    [models]
  );
  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models.filter((model) => {
      if (provider !== "all" && model.provider !== provider) return false;
      if (!normalized) return true;
      return [
        model.name,
        model.id,
        model.provider,
        model.minimumPlan,
        getModelUsageProfile(model).category,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [models, provider, query]);

  const changedCount = Object.keys(drafts).filter((modelId) => {
    const current = overrideMap.get(modelId);
    const draft = drafts[modelId];
    if (!draft) return false;
    return (
      (draft.status || current?.status || "available") !== (current?.status || "available") ||
      (draft.reason ?? current?.reason ?? "") !== (current?.reason ?? "") ||
      (draft.visibleNote ?? current?.visibleNote ?? "") !== (current?.visibleNote ?? "")
    );
  }).length;

  const valueFor = (modelId: string, key: keyof ModelOverrideRow) => {
    const draft = drafts[modelId];
    const current = overrideMap.get(modelId);
    return (draft?.[key] ?? current?.[key] ?? "") as string;
  };

  const setDraft = (modelId: string, patch: Partial<ModelOverrideRow>) => {
    setDrafts((current) => ({
      ...current,
      [modelId]: { ...current[modelId], ...patch },
    }));
  };

  const save = async (model: AiModel) => {
    if (savingId) return;
    const current = overrideMap.get(model.id);
    const draft = drafts[model.id] || {};
    const status = (draft.status || current?.status || "available") as AdminModelOverrideStatus;
    const reason = (draft.reason ?? current?.reason ?? "").trim();
    const visibleNote = (draft.visibleNote ?? current?.visibleNote ?? "").trim();
    setSavingId(model.id);
    try {
      const response = await fetch("/api/admin/model-overrides", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          status,
          reason: reason || null,
          visibleNote: visibleNote || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { overrides?: ModelOverrideRow[]; error?: string }
        | null;
      if (!response.ok || !data?.overrides) {
        throw new Error(data?.error || "Failed to save model override.");
      }
      setItems(data.overrides);
      setDrafts((current) => {
        const next = { ...current };
        delete next[model.id];
        return next;
      });
      dispatchAppToast("Model override saved.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Failed to save model override.",
        "error"
      );
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Model controls
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">Block, limit, or recover models</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            These overrides are enforced by the chat API and shown in public model status.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
          <ShieldAlert className="h-3.5 w-3.5" />
          {changedCount} unsaved
        </span>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_14rem]">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search model, provider, tier..."
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm font-bold text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
        >
          <option value="all">All providers</option>
          {providers.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5 grid gap-3">
        {filteredModels.map((model) => {
          const current = overrideMap.get(model.id);
          const status = (valueFor(model.id, "status") || "available") as AdminModelOverrideStatus;
          return (
            <article key={model.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="grid gap-4 xl:grid-cols-[1fr_12rem_1fr_auto] xl:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <ModelLogo provider={model.provider} size="md" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-black text-white">{model.name}</h3>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(status)}`}>
                        {statusOptions.find((option) => option.value === status)?.label || status}
                      </span>
                      {model.publiclyListed === false ? (
                        <span className="rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs font-bold text-zinc-300">
                          Hidden from users
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-zinc-500">
                      {model.id} · {model.provider} · {getModelUsageProfile(model).category} · {model.minimumPlan}+ · {dateLabel(current?.updatedAt)} UTC
                    </p>
                  </div>
                </div>

                <select
                  value={status}
                  onChange={(event) =>
                    setDraft(model.id, { status: event.target.value as AdminModelOverrideStatus })
                  }
                  className="h-10 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm font-bold text-white outline-none transition focus:border-blue-500"
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <div className="grid gap-2 md:grid-cols-2">
                  <input
                    value={valueFor(model.id, "reason")}
                    onChange={(event) => setDraft(model.id, { reason: event.target.value })}
                    placeholder="Internal reason"
                    className="h-10 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                  <input
                    value={valueFor(model.id, "visibleNote")}
                    onChange={(event) => setDraft(model.id, { visibleNote: event.target.value })}
                    placeholder="User-visible note"
                    className="h-10 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => save(model)}
                  disabled={savingId === model.id}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {savingId === model.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
