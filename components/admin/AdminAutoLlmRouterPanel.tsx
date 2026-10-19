"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Route } from "lucide-react";
import {
  describeAdminApiFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminAutoLlmRouterMessages } from "@/lib/adminMessages/autoLlmRouter";
import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";

type RouterModelOption = { id: string; name: string; provider: string };
type RouterSetting = { modelId: string | null; rewrite: boolean; options: RouterModelOption[] };

const OFF = "";

/**
 * Which model makes Auto's per-prompt choice. One select, one save; off is a
 * real choice in the list, not an absent value.
 */
export function AdminAutoLlmRouterPanel() {
  const m = useAdminMessages(adminAutoLlmRouterMessages);
  const { locale: apiLocale } = useAdminLocale();
  const [setting, setSetting] = useState<RouterSetting | null>(null);
  const [draft, setDraft] = useState(OFF);
  const [rewriteDraft, setRewriteDraft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = (next: RouterSetting) => {
    setSetting(next);
    setDraft(next.modelId ?? OFF);
    setRewriteDraft(next.rewrite);
  };

  const load = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/auto-llm-router");
      if (!response.ok) {
        setFailure(
          await readAdminApiFailure(response, { fallback: m.loadFailed, locale: apiLocale })
        );
        return;
      }
      apply((await response.json()) as RouterSetting);
      setFailure(null);
    } catch {
      setFailure(
        describeAdminApiFailure({ status: 0, fallback: m.loadFailed, locale: apiLocale })
      );
    }
  }, [apiLocale, m.loadFailed]);

  useEffect(() => {
    // Deferred a tick so no state write is synchronous within the effect.
    queueMicrotask(() => void load());
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await adminFetch("/api/admin/auto-llm-router", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: draft === OFF ? null : draft, rewrite: rewriteDraft }),
      });
      if (!response.ok) {
        setFailure(
          await readAdminApiFailure(response, { fallback: m.saveFailed, locale: apiLocale })
        );
        return;
      }
      apply((await response.json()) as RouterSetting);
      setSaved(true);
    } catch {
      setFailure(
        describeAdminApiFailure({ status: 0, fallback: m.saveFailed, locale: apiLocale })
      );
    } finally {
      setSaving(false);
    }
  };

  const unchanged = draft === (setting?.modelId ?? OFF) && rewriteDraft === (setting?.rewrite ?? false);

  return (
    <section
      data-testid="admin-auto-llm-router"
      className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-5"
    >
      <h2 className="flex items-center gap-2 text-base font-bold text-zinc-100">
        <Route className="h-4 w-4 text-blue-300" aria-hidden />
        {m.title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">{m.description}</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex min-w-64 flex-col gap-1 text-xs font-bold text-zinc-300">
          {m.label}
          <select
            value={draft}
            disabled={!setting || saving}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            data-testid="admin-auto-llm-router-select"
            className="min-h-11 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-medium text-zinc-100"
          >
            <option value={OFF}>{m.off}</option>
            {setting?.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({option.provider})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!setting || saving || unchanged}
          data-testid="admin-auto-llm-router-save"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {saving ? m.saving : m.save}
        </button>
        {saved ? (
          <span role="status" className="text-xs font-medium text-zinc-300">
            {m.saved}
          </span>
        ) : null}
      </div>
      <label className="mt-4 flex min-h-11 items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={rewriteDraft}
          disabled={!setting || saving}
          onChange={(event) => {
            setRewriteDraft(event.target.checked);
            setSaved(false);
          }}
          data-testid="admin-auto-llm-router-rewrite"
          className="mt-0.5 h-5 w-5"
        />
        <span>
          <span className="font-bold">{m.rewriteLabel}</span>
          <span className="mt-1 block text-xs text-zinc-500">{m.rewriteDescription}</span>
        </span>
      </label>
      <p className="mt-3 text-xs text-zinc-500">{m.costNote}</p>
      {failure ? <AdminApiFailureNotice failure={failure} onRetry={() => void load()} /> : null}
    </section>
  );
}
