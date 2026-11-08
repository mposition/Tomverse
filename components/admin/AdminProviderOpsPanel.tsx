"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Loader2, Play } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import type { AiModel, AiProvider } from "@/lib/models";
import { AI_PROVIDERS } from "@/lib/modelRegistryShared";
import { adminProviderOpsMessages } from "@/lib/adminMessages/providerOps";
import { adminProviderBoardMessages } from "@/lib/adminMessages/providerBoard";
import type { FallbackChain } from "@/lib/adminProviderBoardCore";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";

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
  /** The fallback order per provider; null when provider health could not be read. */
  chains: readonly FallbackChain[] | null;
  /** ops:write. The routes enforce it on their own; this only tells the operator first. */
  canWrite?: boolean;
};

const providers: readonly AiProvider[] = AI_PROVIDERS;

const providerLabel: Record<AiProvider, string> = {
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
  sail: "Sail Research",
};

const dateLabel = (value: string | null) => formatAestDateTime(value) ?? "-";

const checkTone = (status: string): AdminTone =>
  status === "ok" ? "ok" : status === "disabled" || status === "failed" ? "bad" : "warn";

/** How many incidents the timeline lists; the read itself is bounded to 50. */
const RECENT_INCIDENTS = 8;

export function AdminProviderOpsPanel({ models, incidents, checks, chains, canWrite = true }: Props) {
  const m = useAdminMessages(adminProviderOpsMessages);
  const bm = useAdminMessages(adminProviderBoardMessages);
  const b = bm.fallback;
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
      const response = await adminFetch("/api/admin/provider-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: targetProvider }),
      });
      const data = (await response.json().catch(() => null)) as {
        check?: ProviderHealthCheckRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.check) {
        throw new Error(data?.error || m.testFailed);
      }
      setCheckItems((current) => [data.check!, ...current].slice(0, 50));
      dispatchAppToast(
        data.check.status === "ok" ? m.readinessPassed : data.check.message || m.readinessFailed,
        data.check.status === "ok" ? "success" : "error"
      );
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.testFailed, "error");
    } finally {
      setBusy(null);
    }
  };

  const createIncident = async () => {
    if (busy) return;
    setBusy("create");
    try {
      const response = await adminFetch("/api/admin/incidents", {
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
        throw new Error(data?.error || m.incidentCreateFailed);
      }
      setIncidentItems((current) => [data.incident!, ...current].slice(0, 50));
      setTitle("");
      setMessage("");
      setModelId("");
      dispatchAppToast(m.incidentEnabled, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.incidentCreateFailed, "error");
    } finally {
      setBusy(null);
    }
  };

  const resolveIncident = async (incidentId: string) => {
    if (busy) return;
    setBusy(`resolve-${incidentId}`);
    try {
      const response = await adminFetch("/api/admin/incidents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId, action: "resolve" }),
      });
      const data = (await response.json().catch(() => null)) as {
        incident?: AdminProviderIncidentRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.incident) {
        throw new Error(data?.error || m.resolveFailed);
      }
      setIncidentItems((current) =>
        current.map((item) => (item.id === incidentId ? data.incident! : item))
      );
      dispatchAppToast(m.incidentResolved, "success");
    } catch (error) {
      dispatchAppToast(error instanceof Error ? error.message : m.resolveFailed, "error");
    } finally {
      setBusy(null);
    }
  };

  const latestCheckByProvider = new Map<string, ProviderHealthCheckRow>();
  for (const check of checkItems) {
    if (!latestCheckByProvider.has(check.provider)) latestCheckByProvider.set(check.provider, check);
  }
  const passedChecks = Array.from(latestCheckByProvider.values()).filter((check) => check.status === "ok").length;
  const field =
    "h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500";

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <AdminTile title={b.chainTitle} description={b.chainDescription} data-testid="provider-fallback-chains">
          {chains === null ? (
            <AdminStateBlock kind="error" title={bm.readFailed(bm.reads.health)} detail={bm.readFailedDetail} />
          ) : chains.length === 0 ? (
            <AdminStateBlock kind="empty" title={b.empty} />
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-800">
              {chains.map((chain) => {
                const trouble = chain.status !== "available";
                return (
                  <li
                    key={chain.provider}
                    data-testid={`provider-chain-${chain.provider}`}
                    data-trouble={trouble ? "true" : undefined}
                    className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0"
                  >
                    <ChainNode
                      provider={chain.provider}
                      name={chain.displayName}
                      note={trouble ? b.chainNow : bm.state[chain.status]}
                      highlight={trouble}
                    />
                    {chain.steps.length === 0 ? (
                      <span className="text-xs text-zinc-500">{b.noSteps}</span>
                    ) : (
                      chain.steps.map((step, index) => (
                        <span key={step.modelId} className="flex items-center gap-2">
                          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                          <ChainNode
                            provider={step.provider || "ai"}
                            name={step.name}
                            note={b.step(index + 1)}
                          />
                        </span>
                      ))
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </AdminTile>

        <AdminTile
          title={b.recentTitle}
          description={b.recentBound(RECENT_INCIDENTS)}
          data-testid="provider-recent-incidents"
        >
          {incidentItems.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.noIncidents} />
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-800">
              {incidentItems.slice(0, RECENT_INCIDENTS).map((incident) => {
                const open = incident.status !== "resolved";
                return (
                  <li key={incident.id} className="py-3 first:pt-0 last:pb-0">
                    <article className="flex flex-wrap items-start gap-3">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${open ? "bg-amber-500" : "bg-emerald-500"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-white">{incident.title}</h3>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {incident.provider || incident.modelId || m.unknownTarget}
                          {" · "}
                          {m.created(dateLabel(incident.createdAt), incident.createdByEmail || m.unknownAdmin)}
                        </p>
                        <p className="mt-1 text-sm text-zinc-400">{incident.message || m.noOperatorNote}</p>
                        {open ? null : (
                          <p className="mt-1 text-xs text-zinc-500">{m.resolvedAt(dateLabel(incident.resolvedAt))}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <AdminStatusChip tone={open ? "warn" : "ok"}>
                          {open ? b.activeBadge : b.resolvedBadge}
                        </AdminStatusChip>
                        {open ? (
                          <AdminWriteButton
                            variant="secondary"
                            size="sm"
                            writable={canWrite}
                            requiredRole="ops:write"
                            onClick={() => resolveIncident(incident.id)}
                            disabled={Boolean(busy)}
                          >
                            {busy === `resolve-${incident.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            ) : null}
                            {m.resolve}
                          </AdminWriteButton>
                        ) : null}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
        </AdminTile>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <AdminTile
          title={m.incidentMode}
          description={b.incidentDescription}
          action={<AdminStatusChip tone={activeIncidents.length > 0 ? "warn" : "idle"}>{m.activeIncidents(activeIncidents.length)}</AdminStatusChip>}
        >
          <p className="rounded-xl bg-zinc-950/50 px-3 py-2 text-xs text-zinc-400">{b.switchNote}</p>
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-bold text-zinc-400">
              {m.provider}
              <select
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as AiProvider);
                  setModelId("");
                }}
                className={field}
              >
                {providers.map((item) => (
                  <option key={item} value={item}>
                    {providerLabel[item]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-bold text-zinc-400">
              {m.scope}
              <select value={modelId} onChange={(event) => setModelId(event.target.value)} className={field}>
                <option value="">{m.allProviderModels}</option>
                {providerModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-bold text-zinc-400">
              {m.status}
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as "limited" | "disabled")}
                className={field}
              >
                <option value="limited">{m.limited}</option>
                <option value="disabled">{m.disabled}</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-bold text-zinc-400">
              {m.titleLabel}
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={m.titlePlaceholder}
                className={field}
              />
            </label>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={m.messagePlaceholder}
              className="min-h-24 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm text-white outline-none focus:border-blue-500"
            />
            <AdminWriteButton
              variant="danger"
              writable={canWrite}
              requiredRole="ops:write"
              onClick={createIncident}
              disabled={busy === "create" || title.trim().length < 3}
            >
              {busy === "create" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <AlertTriangle className="h-4 w-4" aria-hidden />
              )}
              {m.enableIncidentMode}
            </AdminWriteButton>
          </div>
        </AdminTile>

        <AdminTile
          title={m.readinessTests}
          description={b.readinessLatest}
          action={
            latestCheckByProvider.size > 0 ? (
              <AdminStatusChip tone={passedChecks === latestCheckByProvider.size ? "ok" : "warn"}>
                {b.readinessSummary(passedChecks, latestCheckByProvider.size)}
              </AdminStatusChip>
            ) : undefined
          }
        >
          <div className="grid grid-cols-2 gap-2">
            {providers.map((item) => (
              <AdminWriteButton
                key={item}
                variant="secondary"
                size="sm"
                writable={canWrite}
                requiredRole="ops:write"
                onClick={() => runProviderTest(item)}
                disabled={Boolean(busy)}
                className="justify-between"
              >
                {providerLabel[item]}
                {busy === `test-${item}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="h-3.5 w-3.5" aria-hidden />
                )}
              </AdminWriteButton>
            ))}
          </div>
          {checkItems.length === 0 ? (
            <AdminStateBlock kind="empty" title={b.readinessNone} />
          ) : (
            <ul className="flex flex-col divide-y divide-zinc-800">
              {checkItems.slice(0, 6).map((check) => (
                <li key={check.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-white">
                      {providerLabel[check.provider as AiProvider] || check.provider}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-zinc-400">
                      {check.message || check.errorCode || m.noDetails}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {dateLabel(check.createdAt)} / {check.latencyMs ?? "-"} ms
                    </p>
                  </div>
                  <AdminStatusChip tone={checkTone(check.status)}>
                    {check.status === "ok" ? b.checkPassed : check.status === "failed" ? b.checkFailed : check.status}
                  </AdminStatusChip>
                </li>
              ))}
            </ul>
          )}
        </AdminTile>
      </div>
    </div>
  );
}

function ChainNode({
  provider,
  name,
  note,
  highlight = false,
}: {
  provider: string;
  name: string;
  note: string;
  highlight?: boolean;
}) {
  return (
    <span
      className={`flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 ${
        highlight ? "border-amber-500/40 bg-amber-500/10" : "border-zinc-800 bg-zinc-950/40"
      }`}
    >
      <ModelLogo provider={provider} size="md" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-white">{name}</span>
        <span className={`block truncate text-xs ${highlight ? "text-amber-300" : "text-zinc-500"}`}>{note}</span>
      </span>
    </span>
  );
}
