"use client";

import { Copy, FilterX, Loader2, Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";
import {
  MODEL_LIFECYCLE_FILTERS,
  modelLifecycleState,
  normalizeModelLifecycleFilter,
  type ModelLifecycleFilter,
  type ModelLifecycleState,
} from "@/lib/adminModelRegistryFilters";
import { canUseModelWithPlan, getModelUsageCredits, type AiModel, type AiProvider } from "@/lib/models";
import type { AdminTone } from "@/lib/adminUiCore";

/** The registry row as the list reads it: the model plus the environment check. */
export type ModelRegistryRow = AiModel & {
  environment: { apiKeyConfigured: boolean; apiKeyEnvName: string };
};

// Company names for the filter chips. A provider this map does not know shows
// its own id rather than a guess.
const COMPANY_NAME: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  moonshot: "Moonshot",
  minimax: "MiniMax",
  qwen: "Qwen",
  zhipu: "Zhipu",
  perplexity: "Perplexity",
  deepinfra: "DeepInfra",
  together: "Together",
  openrouter: "OpenRouter",
  sail: "Sail",
};

export const modelCompanyName = (provider: string) => COMPANY_NAME[provider] ?? provider;

const STATE_TONE: Record<ModelLifecycleState, AdminTone> = {
  active: "ok",
  limited: "warn",
  "coming-soon": "info",
  disabled: "idle",
  retired: "idle",
  archived: "idle",
};

const PLAN_CHIP_CLASS: Record<string, string> = {
  Guest: "bg-zinc-800 text-zinc-300",
  Free: "bg-zinc-800 text-zinc-300",
  Pro: "bg-blue-500/15 text-blue-300",
  Max: "bg-violet-500/15 text-violet-300",
};

const chipClass = (active: boolean) =>
  `inline-flex min-h-8 shrink-0 items-center rounded-full border px-3 text-xs font-bold transition ${
    active
      ? "border-zinc-100 bg-zinc-100 text-zinc-950"
      : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
  }`;

/**
 * The model registry as one table: who offers it, which plans see it, what an
 * answer costs, and whether it is shown. Reading only -- every change still
 * goes through the editor the caller opens with `onEdit`, which keeps its own
 * validation, approval and audit.
 */
export function ModelRegistryList<Row extends ModelRegistryRow>({
  rows,
  providerCounts,
  provider,
  query,
  lifecycle,
  lifecycleLabels,
  summary,
  hiddenNote,
  loading,
  emptyState,
  canWrite = true,
  roleLabels,
  onQuery,
  onProvider,
  onLifecycle,
  onClear,
  onReload,
  onAdd,
  onEdit,
  onDuplicate,
  labels,
}: {
  rows: readonly Row[];
  /** Models per company inside the current search and view, for the chips. */
  providerCounts: ReadonlyArray<{ provider: AiProvider; count: number }>;
  provider: "all" | AiProvider;
  query: string;
  lifecycle: ModelLifecycleFilter;
  lifecycleLabels: Record<ModelLifecycleFilter, string>;
  summary: string;
  hiddenNote: string | null;
  loading: boolean;
  /** Shown in place of the rows when none match (never when the read failed). */
  emptyState?: React.ReactNode;
  canWrite?: boolean;
  /** The roles a model plays in the defaults ("Fallback", "Guest lead", ...). */
  roleLabels: (model: Row) => string[];
  onQuery: (value: string) => void;
  onProvider: (value: "all" | AiProvider) => void;
  onLifecycle: (value: ModelLifecycleFilter) => void;
  onClear: () => void;
  onReload: () => void;
  onAdd: () => void;
  onEdit: (model: Row) => void;
  onDuplicate: (model: Row) => void;
  labels: {
    searchLabel: string;
    searchPlaceholder: string;
    clear: string;
    reload: string;
    addModel: string;
    editLabel: (name: string) => string;
    duplicateLabel: (name: string) => string;
    duplicateTitle: string;
    internalPrefix: string;
  };
}) {
  const m = useAdminMessages(adminModelsBoardMessages);
  const r = m.registry;

  const columns: AdminDataColumn<Row>[] = [
    {
      key: "model",
      header: r.columns.model,
      render: (model) => {
        const state = modelLifecycleState(model);
        const roles = roleLabels(model);
        return (
          <div className="flex min-w-0 items-start gap-3">
            <ModelLogo provider={model.provider} size="lg" className={model.catalogDeleted ? "opacity-60" : ""} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-zinc-100">{model.name}</span>
                <span data-testid={`model-registry-lifecycle-badge-${model.id}`}>
                  <AdminStatusChip tone={STATE_TONE[state]}>{lifecycleLabels[state]}</AdminStatusChip>
                </span>
                {roles.map((role) => (
                  <span key={role} className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-bold text-blue-300">
                    {role}
                  </span>
                ))}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                {modelCompanyName(model.provider)} · <span className="break-all font-mono">{model.id}</span>
                {model.apiModel && model.apiModel !== model.id ? (
                  <span className="break-all font-mono"> → {model.apiModel}</span>
                ) : null}
              </p>
              {!model.environment.apiKeyConfigured ? (
                <p className="mt-1 text-xs font-bold text-amber-300">
                  {r.keyMissing} · <span className="font-mono">{model.environment.apiKeyEnvName}</span>
                </p>
              ) : null}
              {model.operationalReason ? (
                <p className="mt-1 line-clamp-2 text-xs text-amber-300">
                  {labels.internalPrefix}
                  {model.operationalReason}
                </p>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      key: "plans",
      header: r.columns.plans,
      render: (model) => {
        const plans = (["Guest", "Free", "Pro", "Max"] as const).filter((plan) =>
          plan === "Guest" ? model.minimumPlan === "Guest" : canUseModelWithPlan(plan, model)
        );
        return (
          <div className="flex flex-wrap gap-1.5">
            {plans.map((plan) => (
              <span
                key={plan}
                className={`rounded-md px-2 py-0.5 text-xs font-bold ${PLAN_CHIP_CLASS[plan]}`}
              >
                {r.plan[plan]}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: "credits",
      header: r.columns.credits,
      render: (model) => (
        <span className="font-bold tabular-nums text-zinc-100">
          {r.credits(getModelUsageCredits(model))}
        </span>
      ),
    },
    {
      key: "visible",
      header: r.columns.visible,
      render: (model) => {
        const shown = model.enabled && model.publiclyListed !== false && !model.catalogDeleted;
        // A switch that looks like it saves would be a lie: turning a model off
        // needs a replacement and an approval, which the editor asks for. So the
        // switch shows the state and opens the editor.
        return (
          <button
            type="button"
            role="switch"
            aria-checked={shown}
            aria-label={r.visibilitySwitch(model.name)}
            title={r.visibilityHint}
            onClick={() => onEdit(model)}
            className="inline-flex items-center gap-2 rounded-full"
          >
            <span
              className={`flex h-6 w-11 items-center rounded-full p-0.5 transition ${
                shown ? "bg-emerald-500 justify-end" : "bg-zinc-700 justify-start"
              }`}
            >
              <span className="h-5 w-5 rounded-full bg-white shadow" />
            </span>
            <span className="text-xs font-medium text-zinc-400">{shown ? r.shown : r.hidden}</span>
          </button>
        );
      },
    },
    {
      key: "actions",
      header: <span className="sr-only">{r.columns.actions}</span>,
      align: "right",
      render: (model) => (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDuplicate(model)}
            aria-label={labels.duplicateLabel(model.name)}
            title={labels.duplicateTitle}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            <Copy className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onEdit(model)}
            aria-label={labels.editLabel(model.name)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ),
    },
  ];

  const toolbar = (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <span className="sr-only">{labels.searchLabel}</span>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={labels.searchPlaceholder}
            className="min-h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <div role="group" aria-label={r.filterLabel} className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={provider === "all"}
            onClick={() => onProvider("all")}
            data-testid="model-registry-provider-chip-all"
            className={chipClass(provider === "all")}
          >
            {r.filterAll(providerCounts.reduce((sum, item) => sum + item.count, 0))}
          </button>
          {providerCounts.map((item) => (
            <button
              key={item.provider}
              type="button"
              aria-pressed={provider === item.provider}
              onClick={() => onProvider(provider === item.provider ? "all" : item.provider)}
              data-testid={`model-registry-provider-chip-${item.provider}`}
              className={chipClass(provider === item.provider)}
            >
              {modelCompanyName(item.provider)} {item.count}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onReload}
            disabled={loading}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            {labels.reload}
          </button>
          <AdminWriteButton writable={canWrite} requiredRole="ops" onClick={onAdd}>
            <Plus className="h-4 w-4" aria-hidden />
            {labels.addModel}
          </AdminWriteButton>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          {r.lifecycleLabel}
          <select
            value={lifecycle}
            onChange={(event) => onLifecycle(normalizeModelLifecycleFilter(event.target.value))}
            data-testid="model-registry-lifecycle-filter"
            className="min-h-9 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
          >
            {MODEL_LIFECYCLE_FILTERS.map((item) => (
              <option key={item} value={item}>
                {lifecycleLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-blue-300 hover:bg-blue-500/10"
        >
          <FilterX className="h-3.5 w-3.5" aria-hidden />
          {labels.clear}
        </button>
        <p className="text-xs text-zinc-400" role="status" data-testid="model-registry-result-summary">
          <span className="font-bold text-zinc-300">{summary}</span>
          {hiddenNote ? <span className="ml-2 text-zinc-500">{hiddenNote}</span> : null}
        </p>
      </div>
    </div>
  );

  return (
    <AdminDataTable
      caption={r.tableCaption}
      columns={columns}
      rows={rows}
      rowKey={(model) => model.id}
      toolbar={toolbar}
      cardTitle={(model) => (
        <span className="flex items-center gap-2">
          <ModelLogo provider={model.provider} size="md" />
          {model.name}
        </span>
      )}
      cardMeta={(model) => (
        <span>
          {modelCompanyName(model.provider)} · {r.credits(getModelUsageCredits(model))} ·{" "}
          {lifecycleLabels[modelLifecycleState(model)]}
        </span>
      )}
      cardAside={(model) => (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onDuplicate(model)}
            aria-label={labels.duplicateLabel(model.name)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300"
          >
            <Copy className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onEdit(model)}
            aria-label={labels.editLabel(model.name)}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-300"
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
      emptyState={emptyState}
    />
  );
}
