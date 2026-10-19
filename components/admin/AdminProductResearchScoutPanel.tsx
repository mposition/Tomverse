"use client";

import { useState } from "react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminFetch } from "@/lib/adminFetch";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import type { ScoutConsoleSuggestion, ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";

/**
 * The Scout's suggestions (docs/policy/product-research-agent.md §10): what a
 * model found worth improving on a public page, a generated file or the
 * catalogue. The operator dismisses a suggestion or sends it to AMUX as an
 * idea; nothing else happens from here. A separate component from the
 * observation table, which proposes nothing.
 *
 * Everything shown is stored text the model wrote; React escapes it.
 */
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), template);

const SEVERITY_CLASS: Record<string, string> = {
  high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-zinc-400/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
};

const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";

/** One request id per suggestion, kept across reloads, so a lost answer is read back rather than sent twice. */
const sendRequestId = (suggestionId: string) => {
  const key = `product-research-scout-send:${suggestionId}`;
  try {
    const kept = window.sessionStorage.getItem(key);
    if (kept) return kept;
    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return window.crypto.randomUUID();
  }
};

type RowState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly action: "dismiss" | "send" }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly failure: AdminApiFailure };

export function AdminProductResearchScoutPanel({ initial }: { initial: ScoutConsoleView }) {
  const m = useAdminMessages(adminProductResearchScoutMessages);
  const { locale } = useAdminLocale();
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const act = async (suggestion: ScoutConsoleSuggestion, action: "dismiss" | "send") => {
    setRows((current) => ({ ...current, [suggestion.id]: { kind: "busy", action } }));
    let response: Response;
    try {
      response = await adminFetch(`/api/admin/product-research/suggestions/${encodeURIComponent(suggestion.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "send" ? { action, requestId: sendRequestId(suggestion.id) } : { action }),
      });
    } catch {
      setRows((current) => ({ ...current, [suggestion.id]: { kind: "failed", failure: adminNetworkFailure(locale) } }));
      return;
    }
    if (!response.ok) {
      const failure = await readAdminApiFailure(response, { fallback: m.failed, locale });
      setRows((current) => ({ ...current, [suggestion.id]: { kind: "failed", failure } }));
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string; amuxIdeaId?: string | null };
    const message =
      body.status === "sent" || body.amuxIdeaId
        ? fill(m.sent, { ideaId: body.amuxIdeaId ?? "-" })
        : m.dismissed;
    setRows((current) => ({ ...current, [suggestion.id]: { kind: "done", message } }));
  };

  const [settings, setSettings] = useState(initial.settings);
  const [draftModel, setDraftModel] = useState(initial.settings.modelId ?? "");
  const [draftCap, setDraftCap] = useState(String(initial.settings.dailyCallCap));
  const [saveState, setSaveState] = useState<
    { readonly kind: "idle" | "saving" | "saved" } | { readonly kind: "failed"; readonly failure: AdminApiFailure }
  >({ kind: "idle" });

  const save = async () => {
    const cap = Number.parseInt(draftCap, 10);
    const next = { modelId: draftModel || null, dailyCallCap: Number.isInteger(cap) && cap >= 0 ? cap : 0 };
    setSaveState({ kind: "saving" });
    let response: Response;
    try {
      response = await adminFetch("/api/admin/product-research/scout-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
    } catch {
      setSaveState({ kind: "failed", failure: adminNetworkFailure(locale) });
      return;
    }
    if (!response.ok) {
      setSaveState({ kind: "failed", failure: await readAdminApiFailure(response, { fallback: m.failed, locale }) });
      return;
    }
    setSettings(next);
    setSaveState({ kind: "saved" });
  };

  const status = !initial.enabled
    ? m.disabled
    : !settings.modelId
      ? m.modelOff
      : settings.dailyCallCap === 0
        ? m.capZero
        : null;

  return (
    <section
      className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      data-testid="admin-product-research-scout"
    >
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{m.heading}</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{m.intro}</p>
      {status ? <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{status}</p> : null}
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {fill(m.counts, initial.counts)}
      </p>

      <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800" data-testid="admin-product-research-scout-settings">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{m.settingsHeading}</h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {fill(m.usage, {
            calls: initial.usageToday.calls,
            cap: settings.dailyCallCap,
            input: initial.usageToday.inputTokens.toLocaleString(),
            output: initial.usageToday.outputTokens.toLocaleString(),
          })}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-col gap-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            {m.modelLabel}
            <select
              className="min-h-11 rounded-lg border border-zinc-300 bg-transparent px-3 text-sm font-normal dark:border-zinc-700"
              value={draftModel}
              disabled={!initial.canConfigure || saveState.kind === "saving"}
              onChange={(event) => setDraftModel(event.target.value)}
            >
              <option value="">{m.modelNone}</option>
              {initial.modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.provider})
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-40 flex-col gap-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
            {m.capLabel}
            <input
              type="number"
              min={0}
              max={500}
              inputMode="numeric"
              className="min-h-11 rounded-lg border border-zinc-300 bg-transparent px-3 text-sm font-normal dark:border-zinc-700"
              value={draftCap}
              disabled={!initial.canConfigure || saveState.kind === "saving"}
              onChange={(event) => setDraftCap(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={`${BUTTON} border-zinc-300 text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800`}
            disabled={!initial.canConfigure || saveState.kind === "saving"}
            onClick={save}
          >
            {saveState.kind === "saving" ? m.saving : m.save}
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{m.capHint}</p>
        {initial.modelOptions.length === 0 ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{m.noImageModels}</p>
        ) : null}
        {!initial.canConfigure ? (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{m.configureNotAllowed}</p>
        ) : null}
        {saveState.kind === "saved" ? (
          <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300" role="status">{m.saved}</p>
        ) : null}
        {saveState.kind === "failed" ? (
          <AdminApiFailureNotice
            failure={saveState.failure}
            returnTo="/admin/engineering-agent?tab=product-research"
            testId="admin-product-research-scout-settings-failure"
          />
        ) : null}
      </div>

      {initial.open.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{m.empty}</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {initial.open.map((suggestion) => {
            const row = rows[suggestion.id] ?? { kind: "idle" as const };
            const busy = row.kind === "busy";
            const done = row.kind === "done";
            return (
              <li
                key={suggestion.id}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                data-testid="admin-product-research-scout-suggestion"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${SEVERITY_CLASS[suggestion.severity] ?? SEVERITY_CLASS.low}`}
                  >
                    {m.severity[suggestion.severity as keyof typeof m.severity] ?? suggestion.severity}
                  </span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {m.subject}: <span className="font-mono">{suggestion.subject}</span> · {suggestion.area}
                  </span>
                </div>
                <h3 className="mt-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{suggestion.title}</h3>
                <dl className="mt-2 grid gap-1 text-sm text-zinc-700 dark:text-zinc-300">
                  <div>
                    <dt className="inline font-semibold">{m.evidence}: </dt>
                    <dd className="inline">{suggestion.evidence}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">{m.suggestion}: </dt>
                    <dd className="inline">{suggestion.suggestion}</dd>
                  </div>
                </dl>

                {done ? (
                  <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300" role="status">
                    {row.message}
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={`${BUTTON} border-zinc-300 text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800`}
                      disabled={busy || !initial.canDismiss}
                      title={initial.canDismiss ? undefined : m.dismissNotAllowed}
                      onClick={() => act(suggestion, "dismiss")}
                    >
                      {busy && row.action === "dismiss" ? m.dismissing : m.dismiss}
                    </button>
                    <button
                      type="button"
                      className={`${BUTTON} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
                      disabled={busy || !initial.canSend}
                      title={initial.canSend ? undefined : m.sendNotAllowed}
                      onClick={() => act(suggestion, "send")}
                    >
                      {busy && row.action === "send" ? m.sending : m.send}
                    </button>
                  </div>
                )}
                {!done && (!initial.canDismiss || !initial.canSend) ? (
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {!initial.canSend ? m.sendNotAllowed : m.dismissNotAllowed}
                  </p>
                ) : null}
                {row.kind === "failed" ? (
                  <AdminApiFailureNotice
                    failure={row.failure}
                    returnTo="/admin/engineering-agent?tab=product-research"
                    testId="admin-product-research-scout-failure"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
