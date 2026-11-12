"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  describeAdminApiFailure,
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminSemanticRetrievalMessages } from "@/lib/adminMessages/semanticRetrieval";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";
import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";
// Type only: the core module imports node:crypto and must not reach the client bundle.
import type { SemanticRetrievalFeature } from "@/lib/semanticRetrievalCore";

type FeatureState = { on: boolean; configured: boolean };
type Setting = {
  features: Record<SemanticRetrievalFeature, FeatureState>;
  keyConfigured: boolean;
  budgetConfigured: boolean;
  privacyNoticePublished: boolean;
  problems: string[];
};
type Draft = Record<SemanticRetrievalFeature, boolean>;

const draftOf = (setting: Setting): Draft =>
  Object.fromEntries(
    Object.entries(setting.features).map(([feature, state]) => [feature, state.on])
  ) as Draft;

/**
 * The five semantic retrieval switches (Cohere). All are off by default.
 *
 * A switch whose environment is incomplete is drawn disabled, except one that
 * is already on: that can always be turned off. `canWrite` only draws the
 * controls locked; the route refuses a write from any other role on its own.
 */
export function AdminSemanticRetrievalPanel({ canWrite = true }: { canWrite?: boolean } = {}) {
  const m = useAdminMessages(adminSemanticRetrievalMessages);
  const screens = useAdminMessages(adminRoutingScreensMessages);
  const { locale: apiLocale } = useAdminLocale();
  const [setting, setSetting] = useState<Setting | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);

  const apply = (next: Setting) => {
    setSetting(next);
    setDraft(draftOf(next));
  };

  const load = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/semantic-retrieval");
      if (!response.ok) {
        setFailure(
          await readAdminApiFailure(response, { fallback: m.loadFailed, locale: apiLocale })
        );
        return;
      }
      apply((await response.json()) as Setting);
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

  const features = setting ? (Object.keys(setting.features) as SemanticRetrievalFeature[]) : [];
  const changed = setting && draft ? features.filter((f) => draft[f] !== setting.features[f].on) : [];

  const save = async () => {
    if (!setting || !draft) return;
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await adminFetch("/api/admin/semantic-retrieval", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(changed.map((f) => [f, draft[f]]))),
      });
      if (!response.ok) {
        setFailure(
          await readAdminApiFailure(response, { fallback: m.saveFailed, locale: apiLocale })
        );
        return;
      }
      apply((await response.json()) as Setting);
      setSaved(true);
    } catch {
      setFailure(
        describeAdminApiFailure({ status: 0, fallback: m.saveFailed, locale: apiLocale })
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminTile
      title={m.title}
      description={m.description}
      data-testid="admin-semantic-retrieval"
    >
      <p className="text-sm font-bold text-amber-300">{m.dataNotice}</p>
      <p className="text-xs text-zinc-500">{m.costNote}</p>
      {setting ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span>{m.keyLabel}</span>
          <AdminStatusChip tone={setting.keyConfigured ? "ok" : "idle"}>
            {setting.keyConfigured ? m.set : m.missing}
          </AdminStatusChip>
          <span>{m.budgetLabel}</span>
          <AdminStatusChip tone={setting.budgetConfigured ? "ok" : "idle"}>
            {setting.budgetConfigured ? m.set : m.missing}
          </AdminStatusChip>
          <span>{m.privacyNoticeLabel}</span>
          <AdminStatusChip tone={setting.privacyNoticePublished ? "ok" : "idle"}>
            {setting.privacyNoticePublished ? m.published : m.notPublished}
          </AdminStatusChip>
        </div>
      ) : null}
      {setting && setting.problems.length > 0 ? (
        <p className="text-xs text-amber-300" data-testid="admin-semantic-retrieval-problems">
          {m.problemsLabel} <code>{setting.problems.join(", ")}</code>
        </p>
      ) : null}
      {features.map((feature) => {
        const state = setting!.features[feature];
        const copy = m.features[feature];
        // An unconfigured switch cannot be turned on, but one already on can be turned off.
        const blocked = !state.configured && !state.on;
        return (
          <label key={feature} className="flex min-h-11 items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft?.[feature] ?? false}
              disabled={!draft || saving || !canWrite || blocked}
              onChange={(event) => {
                setDraft((current) => (current ? { ...current, [feature]: event.target.checked } : current));
                setSaved(false);
              }}
              data-testid={`admin-semantic-retrieval-${feature}`}
              className="mt-0.5 h-5 w-5"
            />
            <span>
              <span className="font-bold">{copy.label}</span>
              {!state.configured ? (
                <span className="ml-2 text-xs font-bold text-amber-300">{m.notConfigured}</span>
              ) : null}
              <span className="mt-1 block text-xs text-zinc-500">{copy.description}</span>
            </span>
          </label>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <AdminWriteButton
          stepUp
          writable={canWrite}
          requiredRole={screens.needsRole}
          onClick={() => void save()}
          disabled={!setting || saving || changed.length === 0}
          data-testid="admin-semantic-retrieval-save"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {saving ? m.saving : m.save}
        </AdminWriteButton>
        {saved ? (
          <span role="status" className="text-xs font-medium text-zinc-300">
            {m.saved}
          </span>
        ) : null}
      </div>
      {failure ? <AdminApiFailureNotice failure={failure} onRetry={() => void load()} /> : null}
    </AdminTile>
  );
}
