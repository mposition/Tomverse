"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play, RotateCcw, ShieldAlert } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import type { AiModel, AiProvider } from "@/lib/models";

export type AdminProviderIncidentRow = {
  id: string;
  provider: string | null;
  modelId: string | null;
  status: string;
  title: string;
  message: string | null;
  fallbackModelIds: string;
  createdByEmail: string | null;
  resolvedByEmail: string | null;
  startsAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

export type ProviderHealthCheckRow = {
  id: string;
  provider: string;
  modelId: string | null;
  status: string;
  latencyMs: number | null;
  errorCode: string | null;
  message: string | null;
  createdByEmail: string | null;
  createdAt: string;
};

type Props = {
  models: readonly AiModel[];
  incidents: AdminProviderIncidentRow[];
  checks: ProviderHealthCheckRow[];
};

const providers: AiProvider[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "moonshot",
  "qwen",
  "zhipu",
  "perplexity",
];

const providerLabel: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  moonshot: "Moonshot",
  qwen: "Qwen",
  zhipu: "Zhipu",
  perplexity: "Perplexity",
};

const dateLabel = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const statusClass = (status: string) => {
  if (status === "ok" || status === "resolved") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "disabled" || status === "failed") return "border-red-500/30 bg-red-500/10 text-red-200";
  return "border-amber-500/30 bg-amber-500/10 text-amber-200";
};

export function AdminProviderOpsPanel({ models, incidents, checks }: Props) {
  const [incidentItems, setIncidentItems] = useState(incidents);
  const [checkItems, setCheckItems] = useState(checks);
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProvider>("openai");
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState<"limited" | "disabled">("limited");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  const providerModels = useMemo(
    () => models.filter((model) => model.provider === provider),
    [models, provider]
  );
  const activeIncidents = incidentItems.filter((item) => item.status !== "resolved");

  const runProviderTest = async (targetProvider: AiProvider) => {
    if (busy) return;
    setBusy(`test-${targetProvider}`);
    try {
      const response = await fetch("/api/admin/provider-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: targetProvider }),
      });
      const data = (await response.json().catch(() => null)) as {
        check?: ProviderHealthCheckRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.check) {
        throw new Error(data?.error || "Provider test failed.");
      }
      setCheckItems((current) => [data.check!, ...current].slice(0, 50));
      dispatchAppToast(
        data.check.status === "ok" ? "Provider readiness test passed." : data.check.message || "Provider readiness test failed.",
        data.check.status === "ok" ? "success" : "error"
      );
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Provider test failed.", "error");
    } finally {
      setBusy(null);
    }
  };

  const createIncident = async () => {
    if (busy) return;
    setBusy("create");
    try {
      const response = await fetch("/api/admin/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: modelId ? undefined : provider,
          modelId: modelId || undefined,
          status,
          title: title.trim(),
          message: message.trim() || undefined,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        incident?: AdminProviderIncidentRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.incident) {
        throw new Error(data?.error || "Incident creation failed.");
      }
      setIncidentItems((current) => [data.incident!, ...current].slice(0, 50));
      setTitle("");
      setMessage("");
      setModelId("");
      dispatchAppToast("Incident mode enabled.", "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Incident creation failed.", "error");
    } finally {
      setBusy(null);
    }
  };

  const resolveIncident = async (incidentId: string) => {
    if (busy) return;
    setBusy(`resolve-${incidentId}`);
    try {
      const response = await fetch("/api/admin/incidents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId, action: "resolve" }),
      });
      const data = (await response.json().catch(() => null)) as {
        incident?: AdminProviderIncidentRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.incident) {
        throw new Error(data?.error || "Could not resolve incident.");
      }
      setIncidentItems((current) =>
        current.map((item) => (item.id === incidentId ? data.incident! : item))
      );
      dispatchAppToast("Incident resolved.", "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : "Could not resolve incident.", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
            Provider operations
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Tests, incidents, and fallback control
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Run readiness checks, limit or disable an affected provider or model, and resolve incidents when traffic can resume.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-200">
          <ShieldAlert className="h-3.5 w-3.5" />
          {activeIncidents.length} active incidents
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-black uppercase tracking-[0.16em] text-zinc-300">
            Incident mode
          </h3>
          <div className="mt-4 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-bold text-zinc-400">
                Provider
                <select
                  value={provider}
                  onChange={(event) => {
                    setProvider(event.target.value as AiProvider);
                    setModelId("");
                  }}
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                >
                  {providers.map((item) => (
                    <option key={item} value={item}>
                      {providerLabel[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-bold text-zinc-400">
                Scope
                <select
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                >
                  <option value="">All provider models</option>
                  {providerModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <label className="grid gap-1 text-xs font-bold text-zinc-400">
                Status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value as "limited" | "disabled")}
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                >
                  <option value="limited">Limited</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-bold text-zinc-400">
                Title
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Provider outage, quota issue, degraded model..."
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
            </div>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="User-facing note shown in the model selector."
              className="min-h-24 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm text-white outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={createIncident}
              disabled={busy === "create" || title.trim().length < 3}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-black text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
              Enable incident mode
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-black uppercase tracking-[0.16em] text-zinc-300">
            Provider readiness tests
          </h3>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {providers.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => runProviderTest(item)}
                disabled={Boolean(busy)}
                className="inline-flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-left text-sm font-bold text-zinc-200 transition hover:border-blue-500/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {providerLabel[item]}
                {busy === `test-${item}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 text-blue-300" />}
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-2">
            {checkItems.slice(0, 6).map((check) => (
              <div key={check.id} className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-black text-white">{providerLabel[check.provider as AiProvider] || check.provider}</span>
                  <span className={`rounded-full border px-2 py-0.5 font-black ${statusClass(check.status)}`}>
                    {check.status}
                  </span>
                </div>
                <p className="mt-1 text-zinc-400">{check.message || check.errorCode || "No details"}</p>
                <p className="mt-1 text-zinc-600">
                  {dateLabel(check.createdAt)} UTC / {check.latencyMs ?? "-"} ms
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        {incidentItems.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            No incident records yet.
          </div>
        ) : (
          incidentItems.slice(0, 8).map((incident) => (
            <article key={incident.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(incident.status)}`}>
                      {incident.status}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {incident.provider || incident.modelId || "unknown target"}
                    </span>
                  </div>
                  <h3 className="mt-2 text-base font-black text-white">{incident.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-zinc-400">{incident.message || "No operator note."}</p>
                  <p className="mt-2 text-xs text-zinc-600">
                    Created {dateLabel(incident.createdAt)} UTC by {incident.createdByEmail || "unknown admin"}
                  </p>
                </div>
                {incident.status !== "resolved" ? (
                  <button
                    type="button"
                    onClick={() => resolveIncident(incident.id)}
                    disabled={Boolean(busy)}
                    className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-black text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy === `resolve-${incident.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Resolve
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-xs font-bold text-zinc-500">
                    <RotateCcw className="h-3.5 w-3.5" />
                    Resolved {dateLabel(incident.resolvedAt)}
                  </span>
                )}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
