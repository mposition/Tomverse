"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Loader2, Mail, MessageSquare, Send } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { dispatchAppToast } from "@/lib/appToast";
import { adminAlertPolicyMessages } from "@/lib/adminMessages/alertPolicy";
import { adminFetch } from "@/lib/adminFetch";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";

export type AlertPolicyRow = {
  id: string;
  name: string;
  provider: string | null;
  isActive: boolean;
  budgetThresholds: string;
  providerFailureThreshold: number;
  modelFailureThreshold: number;
  notifyEmail: boolean;
  notifySlack: boolean;
  notifyDiscord: boolean;
};

type RecentAlert = {
  id: string;
  channel: string;
  title: string;
  status: string;
  createdAt: string;
};

type RecentState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; rows: RecentAlert[]; failed: number };

const parseThresholds = (value: string) => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0 && item <= 100);
    }
  } catch {
    return [50, 80, 95];
  }
  return [50, 80, 95];
};

const RECENT_COUNT = 5;

const statusTone = (status: string): AdminTone =>
  status === "sent" ? "ok" : status === "failed" ? "bad" : "idle";

// A timeline dot per status; static strings so Tailwind sees each class.
const DOT_CLASS: Record<AdminTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  info: "bg-blue-500",
  idle: "bg-zinc-500",
  unknown: "bg-zinc-600",
};

/** The policies and where each one sends, as one table (cards on a phone). */
export function AdminAlertRoutes({ policies }: { policies: AlertPolicyRow[] }) {
  const m = useAdminMessages(adminAlertPolicyMessages);
  const channelChips = (policy: AlertPolicyRow) => {
    const channels = [
      policy.notifyEmail ? { key: "email", label: m.email, Icon: Mail } : null,
      policy.notifySlack ? { key: "slack", label: "Slack", Icon: MessageSquare } : null,
      policy.notifyDiscord ? { key: "discord", label: "Discord", Icon: Bell } : null,
    ].filter((entry) => entry !== null);
    if (channels.length === 0) return <AdminStatusChip tone="idle">{m.noChannel}</AdminStatusChip>;
    return (
      <span className="flex flex-wrap gap-1.5">
        {channels.map(({ key, label, Icon }) => (
          <span
            key={key}
            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 px-2.5 py-1 text-xs font-bold text-zinc-200"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </span>
        ))}
      </span>
    );
  };

  return (
        <AdminTile title={m.routesTitle} description={m.routesDescription} data-testid="alert-routes">
          <AdminDataTable
            caption={m.routesCaption}
            rows={policies}
            rowKey={(policy) => policy.id}
            emptyState={<AdminStateBlock kind="empty" title={m.routesEmpty} />}
            columns={[
              {
                key: "name",
                header: m.columns.policy,
                render: (policy) => <span className="font-bold text-white">{policy.name}</span>,
              },
              {
                key: "provider",
                header: m.columns.appliesTo,
                render: (policy) => policy.provider || m.allProviders,
              },
              {
                key: "budget",
                header: m.columns.budget,
                render: (policy) =>
                  parseThresholds(policy.budgetThresholds)
                    .map((value) => m.percent(value))
                    .join(", "),
              },
              { key: "channels", header: m.columns.goesTo, render: channelChips },
              {
                key: "state",
                header: m.columns.state,
                render: (policy) => (
                  <AdminStatusChip tone={policy.isActive ? "ok" : "idle"}>
                    {policy.isActive ? m.active : m.inactive}
                  </AdminStatusChip>
                ),
              },
            ]}
            cardTitle={(policy) => policy.name}
            cardMeta={(policy) => m.failures(policy.providerFailureThreshold, policy.modelFailureThreshold)}
            cardAside={(policy) => (
              <AdminStatusChip tone={policy.isActive ? "ok" : "idle"}>
                {policy.isActive ? m.active : m.inactive}
              </AdminStatusChip>
            )}
          />
        </AdminTile>
  );
}

export function AdminAlertPolicyPanel() {
  const m = useAdminMessages(adminAlertPolicyMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [policies, setPolicies] = useState<AlertPolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentState>({ kind: "loading" });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await adminFetch("/api/admin/alert-policy", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { policies?: AlertPolicyRow[]; error?: string }
        | null;
      if (!response.ok || !data?.policies) {
        throw new Error(data?.error || messagesRef.current.loadFailed);
      }
      setPolicies(data.policies);
    } catch {
      // A failed read is an error block, never an empty list.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    setRecent({ kind: "loading" });
    try {
      const response = await adminFetch(
        `/api/admin/notifications?take=${RECENT_COUNT}&status=all`,
        { cache: "no-store" }
      );
      const data = (await response.json().catch(() => null)) as
        | { logs?: RecentAlert[]; stats?: { failed?: number } }
        | null;
      if (!response.ok || !data?.logs) throw new Error("recent alerts unavailable");
      setRecent({ kind: "ready", rows: data.logs, failed: data.stats?.failed ?? 0 });
    } catch {
      setRecent({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
      void loadRecent();
    });
  }, [load, loadRecent]);

  const updatePolicy = (id: string, patch: Partial<AlertPolicyRow>) => {
    setPolicies((current) =>
      current.map((policy) => (policy.id === id ? { ...policy, ...patch } : policy))
    );
  };

  const save = async (policy: AlertPolicyRow) => {
    setSavingId(policy.id);
    try {
      const response = await adminFetch("/api/admin/alert-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: policy.id,
          name: policy.name,
          provider: policy.provider,
          isActive: policy.isActive,
          budgetThresholds: parseThresholds(policy.budgetThresholds),
          providerFailureThreshold: policy.providerFailureThreshold,
          modelFailureThreshold: policy.modelFailureThreshold,
          notifyEmail: policy.notifyEmail,
          notifySlack: policy.notifySlack,
          notifyDiscord: policy.notifyDiscord,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { policy?: AlertPolicyRow; error?: string }
        | null;
      if (!response.ok || !data?.policy) {
        throw new Error(data?.error || m.saveFailed);
      }
      setPolicies((current) =>
        current.map((item) => (item.id === data.policy?.id ? data.policy : item))
      );
      dispatchAppToast(m.saved, "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.saveFailed,
        "error"
      );
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {loadFailed ? (
        <AdminStateBlock
          kind="error"
          title={m.loadFailed}
          detail={m.loadFailedDetail}
          onRetry={() => void load()}
        />
      ) : loading ? (
        <AdminStateBlock kind="loading" />
      ) : (
        <>
          <AdminAlertRoutes policies={policies} />

          <AdminTile title={m.title} description={m.description}>
            <div className="grid gap-3">
              {policies.map((policy) => (
                <article key={policy.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="grid flex-1 gap-3 md:grid-cols-4">
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-500">{m.name}</span>
                        <input
                          value={policy.name}
                          onChange={(event) => updatePolicy(policy.id, { name: event.target.value })}
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-500">{m.budgetPercent}</span>
                        <input
                          value={parseThresholds(policy.budgetThresholds).join(",")}
                          onChange={(event) =>
                            updatePolicy(policy.id, {
                              budgetThresholds: JSON.stringify(
                                event.target.value.split(",").map((item) => Number(item.trim()))
                              ),
                            })
                          }
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-500">{m.providerFail}</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={policy.providerFailureThreshold}
                          onChange={(event) =>
                            updatePolicy(policy.id, {
                              providerFailureThreshold: Number(event.target.value),
                            })
                          }
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium text-zinc-500">{m.modelFail}</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={policy.modelFailureThreshold}
                          onChange={(event) =>
                            updatePolicy(policy.id, {
                              modelFailureThreshold: Number(event.target.value),
                            })
                          }
                          className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {[
                        ["notifyEmail", m.email],
                        ["notifySlack", "Slack"],
                        ["notifyDiscord", "Discord"],
                      ].map(([key, label]) => (
                        <label
                          key={key}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-bold text-zinc-300"
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(policy[key as keyof AlertPolicyRow])}
                            onChange={(event) =>
                              updatePolicy(policy.id, {
                                [key]: event.target.checked,
                              } as Partial<AlertPolicyRow>)
                            }
                          />
                          {label}
                        </label>
                      ))}
                      <AdminWriteButton
                        size="sm"
                        onClick={() => void save(policy)}
                        disabled={savingId === policy.id}
                      >
                        {savingId === policy.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                        {m.save}
                      </AdminWriteButton>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-zinc-500">
                    {m.appliesTo(policy.provider || m.allProviders)}
                  </p>
                </article>
              ))}
            </div>
          </AdminTile>
        </>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <AdminTile
          title={m.recentTitle}
          description={m.recentDescription}
          action={
            recent.kind === "ready" && recent.failed > 0 ? (
              <AdminStatusChip tone="warn">{m.recentFailed(recent.failed)}</AdminStatusChip>
            ) : null
          }
          data-testid="alert-recent"
        >
          {recent.kind === "loading" ? (
            <AdminStateBlock kind="loading" />
          ) : recent.kind === "error" ? (
            <AdminStateBlock
              kind="error"
              title={m.loadFailed}
              onRetry={() => void loadRecent()}
            />
          ) : recent.rows.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.recentEmpty} />
          ) : (
            <ul className="flex flex-col">
              {recent.rows.map((row) => {
                const tone = statusTone(row.status);
                return (
                  <li key={row.id} className="flex items-start gap-3 border-t border-zinc-800 py-3 first:border-t-0">
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[tone]}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-zinc-100">{row.title}</p>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {formatAestDateTime(row.createdAt) ?? "-"} · {row.channel}
                      </p>
                    </div>
                    <AdminStatusChip tone={tone}>
                      {m.recentStatus[row.status as keyof typeof m.recentStatus] ?? row.status}
                    </AdminStatusChip>
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            href="/admin/alerts?tab=deliveries"
            className="text-xs font-bold text-blue-300 underline-offset-2 hover:underline"
          >
            {m.recentOpen}
          </Link>
        </AdminTile>

        <AdminTile title={m.probeTitle} description={m.probeDescription} data-testid="alert-probe-shortcut">
          <Link
            href="/admin/alerts?tab=mail-test"
            className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
          >
            <Send className="h-4 w-4" aria-hidden />
            {m.probeOpen}
          </Link>
        </AdminTile>
      </div>
    </div>
  );
}
