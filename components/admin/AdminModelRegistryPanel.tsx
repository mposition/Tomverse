"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  CheckCircle2,
  Database,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import type { AiModel, AiProvider, ModelMinimumPlan, ModelStatus, ModelUsageClass } from "@/lib/models";
import { AI_PROVIDERS, PROVIDER_API_CONFIGURATION } from "@/lib/modelRegistryShared";
import { ModelLogo } from "@/components/chat/ModelLogo";

type EnvironmentStatus = {
  compatible: boolean;
  protocol: "native" | "openai-compatible";
  apiKeyEnvName: string;
  apiKeyConfigured: boolean;
  warnings: string[];
};

type AdminModel = AiModel & { environment: EnvironmentStatus };

type FormState = {
  id: string;
  name: string;
  apiModel: string;
  provider: AiProvider;
  apiBaseUrl: string;
  apiKeyEnvName: string;
  icon: string;
  bestFor: string;
  minimumPlan: ModelMinimumPlan;
  usageClass: ModelUsageClass;
  creditWeight: number;
  publiclyListed: boolean;
  status: ModelStatus;
  replacementModelId: string;
  reasoning: "none" | "low" | "medium" | "high";
  contextWindowTokens: number | null;
  supportsImage: boolean;
  supportsNativePdf: boolean;
  maxImages: number | null;
  maxBase64ImagePayloadBytes: number | null;
  maxOutputTokens: number | null;
  reservationOutputTokens: number | null;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  cachedInputPriceMultiplier: number | null;
  sortOrder: number;
};

const emptyForm = (): FormState => ({
  id: "",
  name: "",
  apiModel: "",
  provider: "openai",
  apiBaseUrl: PROVIDER_API_CONFIGURATION.openai.baseUrl,
  apiKeyEnvName: PROVIDER_API_CONFIGURATION.openai.apiKeyEnvName,
  icon: "",
  bestFor: "",
  minimumPlan: "Guest",
  usageClass: "standard",
  creditWeight: 1,
  publiclyListed: true,
  status: "disabled",
  replacementModelId: "",
  reasoning: "none",
  contextWindowTokens: null,
  supportsImage: false,
  supportsNativePdf: false,
  maxImages: null,
  maxBase64ImagePayloadBytes: null,
  maxOutputTokens: 2048,
  reservationOutputTokens: 1024,
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  cachedInputPriceMultiplier: 1,
  sortOrder: 0,
});

const formFromModel = (model: AdminModel): FormState => ({
  id: model.id,
  name: model.name,
  apiModel: model.apiModel,
  provider: model.provider,
  apiBaseUrl: model.apiBaseUrl || PROVIDER_API_CONFIGURATION[model.provider].baseUrl,
  apiKeyEnvName: model.apiKeyEnvName || PROVIDER_API_CONFIGURATION[model.provider].apiKeyEnvName,
  icon: model.icon,
  bestFor: model.bestFor,
  minimumPlan: model.minimumPlan,
  usageClass: model.usageClass,
  creditWeight: model.creditWeight || 1,
  publiclyListed: model.publiclyListed !== false,
  status: model.status,
  replacementModelId: model.replacementModelId || "",
  reasoning: model.reasoning || "none",
  contextWindowTokens: model.contextWindowTokens || null,
  supportsImage: model.inputCapabilities?.image === true,
  supportsNativePdf: model.inputCapabilities?.nativePdf === true,
  maxImages: model.inputCapabilities?.maxImages || null,
  maxBase64ImagePayloadBytes: model.inputCapabilities?.maxBase64ImagePayloadBytes || null,
  maxOutputTokens: model.maxOutputTokens || null,
  reservationOutputTokens: model.reservationOutputTokens || null,
  inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
  outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
  cachedInputPriceMultiplier: model.cachedInputPriceMultiplier ?? null,
  sortOrder: model.sortOrder || 0,
});

const inputClass =
  "w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";
const labelClass = "grid gap-1.5 text-xs font-bold uppercase tracking-[0.12em] text-zinc-400";

const numericValue = (value: string) => (value === "" ? null : Number(value));

export function AdminModelRegistryPanel() {
  const [models, setModels] = useState<AdminModel[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<"all" | AiProvider>("all");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<EnvironmentStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/models", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { models?: AdminModel[]; error?: string } | null;
      if (!response.ok || !data?.models) throw new Error(data?.error || "Failed to load model registry.");
      setModels(data.models);
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Failed to load model registry.", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models.filter((model) => {
      if (provider !== "all" && model.provider !== provider) return false;
      if (!normalized) return true;
      return [model.id, model.name, model.apiModel, model.provider, model.bestFor]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [models, provider, query]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setValidation(null);
  };

  const selectProvider = (nextProvider: AiProvider) => {
    const previousDefault = PROVIDER_API_CONFIGURATION[form.provider];
    const nextDefault = PROVIDER_API_CONFIGURATION[nextProvider];
    setForm((current) => ({
      ...current,
      provider: nextProvider,
      apiBaseUrl:
        !current.apiBaseUrl || current.apiBaseUrl === previousDefault.baseUrl
          ? nextDefault.baseUrl
          : current.apiBaseUrl,
      apiKeyEnvName:
        !current.apiKeyEnvName || current.apiKeyEnvName === previousDefault.apiKeyEnvName
          ? nextDefault.apiKeyEnvName
          : current.apiKeyEnvName,
    }));
    setValidation(null);
  };

  const validate = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await response.json().catch(() => null)) as { validation?: EnvironmentStatus; error?: string } | null;
      if (!response.ok || !data?.validation) throw new Error(data?.error || "Configuration validation failed.");
      setValidation(data.validation);
      dispatchAppToast("Model configuration is structurally valid.", "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Configuration validation failed.", "error");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const isNew = editingId === "new";
      const updatePayload: Partial<FormState> = { ...form };
      delete updatePayload.id;
      const response = await fetch(
        isNew ? "/api/admin/models" : `/api/admin/models/${encodeURIComponent(form.id)}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isNew ? form : updatePayload),
        }
      );
      const data = (await response.json().catch(() => null)) as { model?: AdminModel; error?: string } | null;
      if (!response.ok || !data?.model) throw new Error(data?.error || "Failed to save model.");
      setModels((current) => {
        const next = current.filter((model) => model.id !== data.model!.id);
        return [...next, data.model!].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      });
      setEditingId(null);
      setValidation(null);
      window.dispatchEvent(new Event("tomverse:model-registry-updated"));
      dispatchAppToast(isNew ? "Model added to the DB registry." : "Model registry updated.", "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Failed to save model.", "error");
    } finally {
      setSaving(false);
    }
  };

  const archive = async (model: AdminModel) => {
    if (!window.confirm(`Remove ${model.name} from the active catalogue? Historical conversations will remain readable.`)) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/models/${encodeURIComponent(model.id)}`, { method: "DELETE" });
      const data = (await response.json().catch(() => null)) as { model?: AdminModel; error?: string } | null;
      if (!response.ok || !data?.model) throw new Error(data?.error || "Failed to archive model.");
      await load();
      setEditingId(null);
      window.dispatchEvent(new Event("tomverse:model-registry-updated"));
      dispatchAppToast("Model removed from the active catalogue.", "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Failed to archive model.", "error");
    } finally {
      setSaving(false);
    }
  };

  const beginCreate = () => {
    setForm(emptyForm());
    setEditingId("new");
    setValidation(null);
  };

  const beginEdit = (model: AdminModel) => {
    setForm(formFromModel(model));
    setEditingId(model.id);
    setValidation(model.environment);
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80">
      <div className="flex flex-col gap-4 border-b border-zinc-800 bg-zinc-900/50 p-5 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.2em] text-blue-300">DB Model Registry</p>
          <h2 className="mt-2 text-2xl font-black text-white">Model catalogue and API configuration</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-zinc-400">
            Add and edit model identity, endpoint, plan access, credits, capabilities, context, and token prices without a code deployment. Secrets remain in Railway environment variables and are never stored here.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} disabled={loading || saving} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reload
          </button>
          <button type="button" onClick={beginCreate} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white hover:bg-blue-500">
            <Plus className="h-4 w-4" /> Add model
          </button>
        </div>
      </div>

      <div className="grid gap-3 border-b border-zinc-800 p-4 md:grid-cols-[1fr_220px]">
        <label className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, model ID, API ID, provider, or purpose" className={`${inputClass} pl-10`} />
        </label>
        <select value={provider} onChange={(event) => setProvider(event.target.value as "all" | AiProvider)} className={inputClass}>
          <option value="all">All providers</option>
          {AI_PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      <div className="grid gap-3 p-4 xl:grid-cols-2">
        {filtered.map((model) => (
          <article key={model.id} className={`rounded-2xl border p-4 ${model.catalogDeleted ? "border-zinc-800 bg-zinc-950/40 opacity-70" : "border-zinc-800 bg-zinc-900/50"}`}>
            <div className="flex items-start gap-3">
              <ModelLogo provider={model.provider} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-black text-white">{model.name}</h3>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${model.enabled && !model.catalogDeleted ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 bg-zinc-950 text-zinc-400"}`}>
                    {model.catalogDeleted ? "Archived" : model.status}
                  </span>
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-black text-amber-200">{model.creditWeight || 1} credits</span>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-zinc-500">{model.id} → {model.apiModel}</p>
                <p className="mt-2 truncate text-xs text-zinc-400">{model.apiBaseUrl}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-bold">
                  <span className="rounded-lg bg-zinc-950 px-2 py-1 text-zinc-300">{model.provider}</span>
                  <span className="rounded-lg bg-zinc-950 px-2 py-1 text-zinc-300">{model.minimumPlan}+</span>
                  <span className="rounded-lg bg-zinc-950 px-2 py-1 text-zinc-300">{model.usageClass}</span>
                  <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 ${model.environment.apiKeyConfigured ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
                    <KeyRound className="h-3 w-3" /> {model.environment.apiKeyEnvName}
                  </span>
                </div>
              </div>
              <button type="button" onClick={() => beginEdit(model)} className="rounded-xl border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800" aria-label={`Edit ${model.name}`}>
                <Pencil className="h-4 w-4" />
              </button>
            </div>
          </article>
        ))}
      </div>

      {editingId ? (
        <div className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-black/75 p-3 backdrop-blur-sm md:p-8" role="dialog" aria-modal="true" aria-label={editingId === "new" ? "Add model" : `Edit ${form.name}`}>
          <div className="my-auto w-full max-w-5xl overflow-hidden rounded-3xl border border-zinc-700 bg-zinc-950 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 p-5 backdrop-blur">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">{editingId === "new" ? "New registry entry" : "Edit registry entry"}</p>
                <h3 className="mt-1 text-xl font-black text-white">{form.name || "Untitled model"}</h3>
              </div>
              <button type="button" onClick={() => setEditingId(null)} className="rounded-xl border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800"><X className="h-5 w-5" /></button>
            </div>

            <div className="grid gap-6 p-5">
              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-2">
                <legend className="px-2 text-sm font-black text-white">Identity and provider API</legend>
                <label className={labelClass}>Registry ID<input disabled={editingId !== "new"} value={form.id} onChange={(e) => setField("id", e.target.value)} className={`${inputClass} disabled:opacity-60`} placeholder="provider/model-name" /></label>
                <label className={labelClass}>Display name<input value={form.name} onChange={(e) => setField("name", e.target.value)} className={inputClass} /></label>
                <label className={labelClass}>Provider<select value={form.provider} onChange={(e) => selectProvider(e.target.value as AiProvider)} className={inputClass}>{AI_PROVIDERS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                <label className={labelClass}>Provider API model ID<input value={form.apiModel} onChange={(e) => setField("apiModel", e.target.value)} className={inputClass} placeholder="Exact model ID sent to provider" /></label>
                <label className={`${labelClass} md:col-span-2`}>API Base URL<input value={form.apiBaseUrl} onChange={(e) => setField("apiBaseUrl", e.target.value)} className={inputClass} /></label>
                <label className={labelClass}>API key environment variable<input value={form.apiKeyEnvName} onChange={(e) => setField("apiKeyEnvName", e.target.value.toUpperCase())} className={inputClass} /></label>
                <label className={labelClass}>Icon / short mark<input value={form.icon} onChange={(e) => setField("icon", e.target.value)} className={inputClass} /></label>
                <label className={`${labelClass} md:col-span-2`}>Model-specific purpose<input value={form.bestFor} onChange={(e) => setField("bestFor", e.target.value)} className={inputClass} placeholder="One concise line shown in the model picker" /></label>
              </fieldset>

              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-4">
                <legend className="px-2 text-sm font-black text-white">Catalogue, access, and credits</legend>
                <label className={labelClass}>Minimum plan<select value={form.minimumPlan} onChange={(e) => setField("minimumPlan", e.target.value as ModelMinimumPlan)} className={inputClass}><option>Guest</option><option>Free</option><option>Pro</option></select></label>
                <label className={labelClass}>Internal usage class<select value={form.usageClass} onChange={(e) => setField("usageClass", e.target.value as ModelUsageClass)} className={inputClass}>{["standard","advanced","premium","reasoning","premium-reasoning","research","deep-research"].map((item) => <option key={item}>{item}</option>)}</select></label>
                <label className={labelClass}>Base credit weight<input type="number" min={1} max={1000} value={form.creditWeight} onChange={(e) => setField("creditWeight", Number(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Runtime status<select value={form.status} onChange={(e) => setField("status", e.target.value as ModelStatus)} className={inputClass}><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="coming-soon">Coming soon</option></select></label>
                <label className="flex items-center gap-2 text-sm font-bold text-zinc-300"><input type="checkbox" checked={form.publiclyListed} onChange={(e) => setField("publiclyListed", e.target.checked)} className="h-4 w-4" /> Publicly listed</label>
                <label className={`${labelClass} md:col-span-2`}>Replacement model<select value={form.replacementModelId} onChange={(e) => setField("replacementModelId", e.target.value)} className={inputClass}><option value="">None</option>{models.filter((model) => model.id !== form.id && !model.catalogDeleted).map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select></label>
                <label className={labelClass}>Sort order<input type="number" value={form.sortOrder} onChange={(e) => setField("sortOrder", Number(e.target.value))} className={inputClass} /></label>
              </fieldset>

              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-4">
                <legend className="px-2 text-sm font-black text-white">Capabilities and context</legend>
                <label className="flex items-center gap-2 text-sm font-bold text-zinc-300"><input type="checkbox" checked={form.supportsImage} onChange={(e) => setField("supportsImage", e.target.checked)} /> Image input</label>
                <label className="flex items-center gap-2 text-sm font-bold text-zinc-300"><input type="checkbox" checked={form.supportsNativePdf} onChange={(e) => setField("supportsNativePdf", e.target.checked)} /> Native PDF</label>
                <label className={labelClass}>Reasoning<select value={form.reasoning} onChange={(e) => setField("reasoning", e.target.value as FormState["reasoning"])} className={inputClass}><option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
                <label className={labelClass}>Context window<input type="number" value={form.contextWindowTokens ?? ""} onChange={(e) => setField("contextWindowTokens", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Max images<input type="number" value={form.maxImages ?? ""} onChange={(e) => setField("maxImages", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Max base64 image bytes<input type="number" value={form.maxBase64ImagePayloadBytes ?? ""} onChange={(e) => setField("maxBase64ImagePayloadBytes", numericValue(e.target.value))} className={inputClass} /></label>
              </fieldset>

              <fieldset className="grid gap-4 rounded-2xl border border-zinc-800 p-4 md:grid-cols-3">
                <legend className="px-2 text-sm font-black text-white">Token limits and cost snapshot (USD per 1M tokens)</legend>
                <label className={labelClass}>Max output tokens<input type="number" value={form.maxOutputTokens ?? ""} onChange={(e) => setField("maxOutputTokens", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Reservation output tokens<input type="number" value={form.reservationOutputTokens ?? ""} onChange={(e) => setField("reservationOutputTokens", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Cached input multiplier<input type="number" min={0} max={1} step="0.01" value={form.cachedInputPriceMultiplier ?? ""} onChange={(e) => setField("cachedInputPriceMultiplier", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Input USD / 1M<input type="number" min={0} step="0.000001" value={form.inputUsdPerMillionTokens ?? ""} onChange={(e) => setField("inputUsdPerMillionTokens", numericValue(e.target.value))} className={inputClass} /></label>
                <label className={labelClass}>Output USD / 1M<input type="number" min={0} step="0.000001" value={form.outputUsdPerMillionTokens ?? ""} onChange={(e) => setField("outputUsdPerMillionTokens", numericValue(e.target.value))} className={inputClass} /></label>
              </fieldset>

              {validation ? (
                <div className={`rounded-2xl border p-4 ${validation.compatible && validation.apiKeyConfigured ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
                  <p className="flex items-center gap-2 font-black text-white"><ShieldCheck className="h-4 w-4" /> Configuration check</p>
                  <p className="mt-2 text-sm text-zinc-300">Protocol: {validation.protocol} · Key: {validation.apiKeyEnvName} ({validation.apiKeyConfigured ? "configured" : "missing"})</p>
                  {validation.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-amber-200">• {warning}</p>)}
                </div>
              ) : null}
            </div>

            <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950/95 p-4 backdrop-blur">
              <div>
                {editingId !== "new" ? (
                  <button type="button" onClick={() => void archive(models.find((model) => model.id === editingId)!)} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-500/10 disabled:opacity-50"><Archive className="h-4 w-4" /> Remove from catalogue</button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void validate()} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"><CheckCircle2 className="h-4 w-4" /> Validate</button>
                <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-sm font-black text-white hover:bg-blue-500 disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {form.id && models.find((model) => model.id === form.id)?.catalogDeleted ? "Restore and save" : "Save model"}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-zinc-500"><Database className="mx-auto mb-3 h-6 w-6" />No models match this filter.</div>
      ) : null}
    </section>
  );
}
