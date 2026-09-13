"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, Loader2, Save } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { dispatchAppToast } from "@/lib/appToast";
import { adminAlertPolicyMessages } from "@/lib/adminMessages/alertPolicy";

type AlertPolicyRow = {
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

export function AdminAlertPolicyPanel() {
  const m = useAdminMessages(adminAlertPolicyMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [policies, setPolicies] = useState<AlertPolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/alert-policy", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { policies?: AlertPolicyRow[]; error?: string }
        | null;
      if (!response.ok || !data?.policies) {
        throw new Error(data?.error || messagesRef.current.loadFailed);
      }
      setPolicies(data.policies);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : messagesRef.current.loadFailed,
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const updatePolicy = (id: string, patch: Partial<AlertPolicyRow>) => {
    setPolicies((current) =>
      current.map((policy) => (policy.id === id ? { ...policy, ...patch } : policy))
    );
  };

  const save = async (policy: AlertPolicyRow) => {
    setSavingId(policy.id);
    try {
      const response = await fetch("/api/admin/alert-policy", {
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
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
          {m.eyebrow}
        </p>
        <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.description}
        </p>
      </div>

      <div className="mt-5 grid gap-3">
        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            {m.loading}
          </div>
        ) : (
          policies.map((policy) => (
            <article key={policy.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="grid flex-1 gap-3 md:grid-cols-4">
                  <label className="block">
                    <span className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500">{m.name}</span>
                    <input
                      value={policy.name}
                      onChange={(event) => updatePolicy(policy.id, { name: event.target.value })}
                      className="mt-1 h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500">{m.budgetPercent}</span>
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
                    <span className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500">{m.providerFail}</span>
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
                    <span className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500">{m.modelFail}</span>
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
                <div className="flex flex-wrap gap-2">
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
                  <button
                    type="button"
                    onClick={() => void save(policy)}
                    disabled={savingId === policy.id}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {savingId === policy.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {m.save}
                  </button>
                </div>
              </div>
              <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                <BellRing className="h-3.5 w-3.5 text-blue-300" />
                {m.appliesTo(policy.provider || m.allProviders)}
              </p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
