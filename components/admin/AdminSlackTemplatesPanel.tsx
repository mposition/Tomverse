"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, Loader2, Save, Send } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { dispatchAppToast } from "@/lib/appToast";
import { adminSlackTemplatesMessages } from "@/lib/adminMessages/slackTemplates";
import type { SlackTemplateKey } from "@/lib/slackMessageTemplateCore";
import { adminFetch } from "@/lib/adminFetch";

type TemplateRow = {
  key: SlackTemplateKey;
  name: string;
  description: string;
  enabled: boolean;
  titleTemplate: string;
  bodyTemplate: string;
  allowedVariables: string[];
  persisted: boolean;
  updatedAt?: string;
};

type WebhookConfiguration = Record<SlackTemplateKey, boolean>;

const EMPTY_WEBHOOK_CONFIGURATION: WebhookConfiguration = {
  infrastructure_daily: false,
  provider_usage_daily: false,
  provider_model_catalog_daily: false,
  provider_alert: false,
};

export function AdminSlackTemplatesPanel() {
  const m = useAdminMessages(adminSlackTemplatesMessages);
  const messagesRef = useRef(m);
  useEffect(() => {
    messagesRef.current = m;
  }, [m]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [webhookConfigured, setWebhookConfigured] =
    useState<WebhookConfiguration>(EMPTY_WEBHOOK_CONFIGURATION);
  const [schedule, setSchedule] = useState("10:00 / 10:30 Australia/Brisbane");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await adminFetch("/api/admin/slack-templates", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | {
            templates?: TemplateRow[];
            webhookConfiguredByTemplate?: Partial<WebhookConfiguration>;
            schedule?: { localTime?: string };
            error?: string;
          }
        | null;
      if (!response.ok || !data?.templates) {
        throw new Error(data?.error || messagesRef.current.loadFailed);
      }
      setTemplates(data.templates);
      setWebhookConfigured({
        ...EMPTY_WEBHOOK_CONFIGURATION,
        ...data.webhookConfiguredByTemplate,
      });
      setSchedule(
        data.schedule?.localTime || "10:00 / 10:30 Australia/Brisbane"
      );
    } catch {
      // A failed read is an error block, never an empty list.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const update = (key: SlackTemplateKey, patch: Partial<TemplateRow>) => {
    setTemplates((current) =>
      current.map((template) =>
        template.key === key ? { ...template, ...patch } : template
      )
    );
  };

  const save = async (template: TemplateRow) => {
    setSavingKey(template.key);
    try {
      const response = await adminFetch("/api/admin/slack-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: template.key,
          enabled: template.enabled,
          titleTemplate: template.titleTemplate,
          bodyTemplate: template.bodyTemplate,
        }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || m.saveFailed);
      dispatchAppToast(m.saved, "success");
      await load();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.saveFailed,
        "error"
      );
    } finally {
      setSavingKey(null);
    }
  };

  const sendTest = async (key: SlackTemplateKey) => {
    setTestingKey(key);
    try {
      const response = await adminFetch("/api/admin/slack-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = (await response.json().catch(() => null)) as
        | { result?: { status?: string; error?: string }; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(data?.result?.error || data?.error || m.testFailed);
      }
      dispatchAppToast(m.testSent, "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.testFailed,
        "error"
      );
    } finally {
      setTestingKey(null);
    }
  };

  const allWebhooks = Object.values(webhookConfigured).every(Boolean);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile
        title={m.title}
        description={m.description}
        action={
          <>
            <AdminStatusChip tone="idle">
              <Clock3 className="h-3.5 w-3.5" aria-hidden /> {m.daily(schedule)}
            </AdminStatusChip>
            {loadFailed ? null : (
              <AdminStatusChip tone={allWebhooks ? "ok" : "bad"}>
                {allWebhooks ? m.webhooksConfigured : m.webhooksIncomplete}
              </AdminStatusChip>
            )}
          </>
        }
      >
        {loadFailed ? (
          <AdminStateBlock
            kind="error"
            title={m.loadFailed}
            detail={m.loadFailedDetail}
            onRetry={() => void load()}
          />
        ) : loading ? (
          <AdminStateBlock kind="loading" />
        ) : null}
      </AdminTile>

      {loadFailed || loading
        ? null
        : templates.map((template) => (
            <AdminTile
              key={template.key}
              as="article"
              title={template.name}
              description={template.description}
              action={
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-bold text-zinc-300">
                  <input
                    type="checkbox"
                    checked={template.enabled}
                    onChange={(event) => update(template.key, { enabled: event.target.checked })}
                  />
                  {m.scheduledDeliveryEnabled}
                </label>
              }
            >
              <label>
                <span className="text-xs font-medium text-zinc-500">{m.titleField}</span>
                <input
                  value={template.titleTemplate}
                  onChange={(event) => update(template.key, { titleTemplate: event.target.value })}
                  maxLength={240}
                  className="mt-1 h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-blue-500"
                />
              </label>
              <label>
                <span className="text-xs font-medium text-zinc-500">{m.bodyField}</span>
                <textarea
                  value={template.bodyTemplate}
                  onChange={(event) => update(template.key, { bodyTemplate: event.target.value })}
                  maxLength={2800}
                  rows={5}
                  className="mt-1 w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 text-white outline-none focus:border-blue-500"
                />
              </label>
              <p className="text-xs leading-5 text-zinc-500">
                {m.variables}
                {template.allowedVariables.map((name) => `{{${name}}}`).join(", ")}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <AdminWriteButton
                  variant="secondary"
                  size="sm"
                  onClick={() => void sendTest(template.key)}
                  disabled={testingKey === template.key || !webhookConfigured[template.key]}
                >
                  {testingKey === template.key ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Send className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {m.sendTest}
                </AdminWriteButton>
                <AdminWriteButton
                  size="sm"
                  onClick={() => void save(template)}
                  disabled={savingKey === template.key}
                >
                  {savingKey === template.key ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Save className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {m.save}
                </AdminWriteButton>
              </div>
            </AdminTile>
          ))}
    </div>
  );
}
