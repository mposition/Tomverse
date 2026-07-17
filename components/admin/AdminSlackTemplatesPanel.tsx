"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock3, Loader2, MessageSquareText, Save, Send } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import type { SlackTemplateKey } from "@/lib/slackMessageTemplateCore";

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
  provider_alert: false,
};

export function AdminSlackTemplatesPanel() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [webhookConfigured, setWebhookConfigured] =
    useState<WebhookConfiguration>(EMPTY_WEBHOOK_CONFIGURATION);
  const [schedule, setSchedule] = useState("10:30 Australia/Brisbane");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/slack-templates", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | {
            templates?: TemplateRow[];
            webhookConfiguredByTemplate?: Partial<WebhookConfiguration>;
            schedule?: { localTime?: string };
            error?: string;
          }
        | null;
      if (!response.ok || !data?.templates) {
        throw new Error(data?.error || "Could not load Slack templates.");
      }
      setTemplates(data.templates);
      setWebhookConfigured({
        ...EMPTY_WEBHOOK_CONFIGURATION,
        ...data.webhookConfiguredByTemplate,
      });
      setSchedule(data.schedule?.localTime || "10:30 Australia/Brisbane");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load Slack templates.",
        "error"
      );
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
      const response = await fetch("/api/admin/slack-templates", {
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
      if (!response.ok) throw new Error(data?.error || "Could not save Slack template.");
      dispatchAppToast("Slack template saved.", "success");
      await load();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not save Slack template.",
        "error"
      );
    } finally {
      setSavingKey(null);
    }
  };

  const sendTest = async (key: SlackTemplateKey) => {
    setTestingKey(key);
    try {
      const response = await fetch("/api/admin/slack-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = (await response.json().catch(() => null)) as
        | { result?: { status?: string; error?: string }; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(data?.result?.error || data?.error || "Slack test failed.");
      }
      dispatchAppToast("Slack test message sent.", "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Slack test failed.",
        "error"
      );
    } finally {
      setTestingKey(null);
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-300">
            Slack messages
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Templates and delivery tests
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Edit scheduled reports and provider alert messages, then send a safe
            test from Admin. Database outage alerts remain independent so they still
            work when the application database is unavailable. Every Slack delivery
            automatically starts with &lt;!channel&gt; to notify the channel.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-black">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-2 text-zinc-300">
            <Clock3 className="h-3.5 w-3.5" /> Daily {schedule}
          </span>
          <span
            className={`rounded-full border px-3 py-2 ${
              Object.values(webhookConfigured).every(Boolean)
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            Webhooks {Object.values(webhookConfigured).every(Boolean) ? "configured" : "incomplete"}
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Slack templates...
          </div>
        ) : (
          templates.map((template) => (
            <article key={template.key} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <MessageSquareText className="h-4 w-4 text-emerald-300" />
                    <h3 className="font-black text-white">{template.name}</h3>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{template.description}</p>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-black text-zinc-300">
                  <input
                    type="checkbox"
                    checked={template.enabled}
                    onChange={(event) => update(template.key, { enabled: event.target.checked })}
                  />
                  Scheduled delivery enabled
                </label>
              </div>
              <div className="mt-4 grid gap-3">
                <label>
                  <span className="text-[11px] font-black uppercase tracking-[0.14em] text-zinc-500">Title</span>
                  <input
                    value={template.titleTemplate}
                    onChange={(event) => update(template.key, { titleTemplate: event.target.value })}
                    maxLength={240}
                    className="mt-1 h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-emerald-500"
                  />
                </label>
                <label>
                  <span className="text-[11px] font-black uppercase tracking-[0.14em] text-zinc-500">Message body</span>
                  <textarea
                    value={template.bodyTemplate}
                    onChange={(event) => update(template.key, { bodyTemplate: event.target.value })}
                    maxLength={2800}
                    rows={5}
                    className="mt-1 w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 text-white outline-none focus:border-emerald-500"
                  />
                </label>
                <p className="text-[11px] leading-5 text-zinc-500">
                  Variables: {template.allowedVariables.map((name) => `{{${name}}}`).join(", ")}
                </p>
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void sendTest(template.key)}
                  disabled={testingKey === template.key || !webhookConfigured[template.key]}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 px-3 py-2 text-xs font-black text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  {testingKey === template.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send test
                </button>
                <button
                  type="button"
                  onClick={() => void save(template)}
                  disabled={savingKey === template.key}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {savingKey === template.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
