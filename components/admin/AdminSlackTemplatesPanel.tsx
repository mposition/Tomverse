"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, Loader2, MessageSquareText, Save, Send } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { dispatchAppToast } from "@/lib/appToast";
import { adminSlackTemplatesMessages } from "@/lib/adminMessages/slackTemplates";
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
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [webhookConfigured, setWebhookConfigured] =
    useState<WebhookConfiguration>(EMPTY_WEBHOOK_CONFIGURATION);
  const [schedule, setSchedule] = useState("10:00 / 10:30 Australia/Brisbane");

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
      const response = await fetch("/api/admin/slack-templates", {
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

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300">
            {m.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            {m.title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            {m.description}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-bold">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-700 px-3 py-2 text-zinc-300">
            <Clock3 className="h-3.5 w-3.5" /> {m.daily(schedule)}
          </span>
          <span
            className={`rounded-full border px-3 py-2 ${
              Object.values(webhookConfigured).every(Boolean)
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            {Object.values(webhookConfigured).every(Boolean)
              ? m.webhooksConfigured
              : m.webhooksIncomplete}
          </span>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        {loading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 p-4 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> {m.loading}
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
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-bold text-zinc-300">
                  <input
                    type="checkbox"
                    checked={template.enabled}
                    onChange={(event) => update(template.key, { enabled: event.target.checked })}
                  />
                  {m.scheduledDeliveryEnabled}
                </label>
              </div>
              <div className="mt-4 grid gap-3">
                <label>
                  <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">{m.titleField}</span>
                  <input
                    value={template.titleTemplate}
                    onChange={(event) => update(template.key, { titleTemplate: event.target.value })}
                    maxLength={240}
                    className="mt-1 h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-white outline-none focus:border-emerald-500"
                  />
                </label>
                <label>
                  <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-zinc-500">{m.bodyField}</span>
                  <textarea
                    value={template.bodyTemplate}
                    onChange={(event) => update(template.key, { bodyTemplate: event.target.value })}
                    maxLength={2800}
                    rows={5}
                    className="mt-1 w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs leading-5 text-white outline-none focus:border-emerald-500"
                  />
                </label>
                <p className="text-[11px] leading-5 text-zinc-500">
                  {m.variables}{template.allowedVariables.map((name) => `{{${name}}}`).join(", ")}
                </p>
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void sendTest(template.key)}
                  disabled={testingKey === template.key || !webhookConfigured[template.key]}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  {testingKey === template.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {m.sendTest}
                </button>
                <button
                  type="button"
                  onClick={() => void save(template)}
                  disabled={savingKey === template.key}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {savingKey === template.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {m.save}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
