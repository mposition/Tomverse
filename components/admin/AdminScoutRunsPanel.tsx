"use client";

import { useState } from "react";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { CHIP, STATE_CHIP, fill, fullNumber, localTime, scoutState } from "@/lib/adminScoutDisplay";
import { adminNetworkFailure, readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import type { ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";

/**
 * The Scout's runs and spending (docs/policy/product-research-agent.md §13):
 * whether it is on, the model and daily cap an owner chose, today's use of the
 * cap, and the last seven UTC days from the call ledger. Choosing the model or
 * the cap is the only control here, and it is an owner's.
 */
const RETURN_TO = "/admin/product-research?tab=runs";

const CARD = "rounded-xl border border-zinc-800 bg-zinc-900 p-5";
const INPUT =
  "min-h-11 rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 disabled:cursor-not-allowed disabled:opacity-60";

export function AdminScoutRunsPanel({ initial }: { initial: ScoutConsoleView }) {
  const m = useAdminMessages(adminProductResearchScoutMessages);
  const { locale } = useAdminLocale();
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

  const state = scoutState({ enabled: initial.enabled, settings });
  const model = initial.modelOptions.find((option) => option.id === settings.modelId);
  const used = initial.usageToday.calls;
  const cap = settings.dailyCallCap;
  const ratio = cap > 0 ? Math.min(1, used / cap) : 0;
  const number = (value: number) => fullNumber(value, locale);
  const todayKey = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="admin-product-research-scout-runs">
      <section className={CARD}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold text-zinc-50">{m.nowHeading}</h2>
          <span className={`${CHIP} ${STATE_CHIP[state]}`}>
            {state === "on" ? m.stateOn : state === "judging_off" ? m.stateJudgingOff : m.stateOff}
          </span>
        </div>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="text-xs text-zinc-500">{m.factSwitch}</dt>
            <dd className="mt-0.5 text-base font-bold text-zinc-50">{initial.enabled ? m.switchOn : m.switchOff}</dd>
            <dd className="mt-0.5 break-all text-xs text-zinc-400">{m.switchHint}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">{m.factModel}</dt>
            <dd className="mt-0.5 text-base font-bold text-zinc-50">{model?.name ?? settings.modelId ?? m.modelNone}</dd>
            {model ? <dd className="mt-0.5 text-xs text-zinc-400">{model.provider}</dd> : null}
          </div>
          <div>
            <dt className="text-xs text-zinc-500">{m.factCap}</dt>
            <dd className="mt-0.5 text-base font-bold text-zinc-50">{fill(m.capValue, { cap })}</dd>
            <dd className="mt-0.5 text-xs text-zinc-400">{m.capFactHint}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">{m.factSchedule}</dt>
            <dd className="mt-0.5 text-base font-bold text-zinc-50">
              {m.scheduleValue.split("{time}")[0]}
              <time dateTime={initial.nextRunAt} suppressHydrationWarning>{localTime(initial.nextRunAt, locale, null)}</time>
              {m.scheduleValue.split("{time}")[1]}
            </dd>
            <dd className="mt-0.5 text-xs text-zinc-400">{m.scheduleHint}</dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={CARD} data-testid="admin-product-research-scout-settings">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-bold text-zinc-50">{m.settingsHeading}</h2>
            <span className={`${CHIP} border-amber-500/40 bg-amber-500/10 text-amber-300`}>{m.ownerOnly}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">{m.settingsIntro}</p>
          <label className="mt-4 flex flex-col gap-1.5 text-xs font-medium text-zinc-300">
            {m.modelLabel}
            <select
              className={INPUT}
              value={draftModel}
              disabled={!initial.canConfigure || saveState.kind === "saving"}
              onChange={(event) => setDraftModel(event.target.value)}
            >
              <option value="">{m.modelNone}</option>
              {initial.modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} · {option.provider}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 flex flex-col gap-1.5 text-xs font-medium text-zinc-300">
            {m.capLabel}
            <input
              type="number"
              min={0}
              max={500}
              inputMode="numeric"
              className={`${INPUT} font-mono`}
              value={draftCap}
              disabled={!initial.canConfigure || saveState.kind === "saving"}
              onChange={(event) => setDraftCap(event.target.value)}
            />
          </label>
          <p className="mt-2 text-xs text-zinc-400">{m.capHint}</p>
          {initial.modelOptions.length === 0 ? <p className="mt-1 text-xs text-amber-300">{m.noImageModels}</p> : null}
          {!initial.canConfigure ? <p className="mt-1 text-xs text-zinc-400">{m.configureNotAllowed}</p> : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-600 px-5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
              disabled={!initial.canConfigure || saveState.kind === "saving"}
              onClick={save}
            >
              {saveState.kind === "saving" ? m.saving : m.save}
            </button>
            {saveState.kind === "saved" ? (
              <p className="text-xs text-zinc-300" role="status">
                {m.saved}
              </p>
            ) : null}
          </div>
          {saveState.kind === "failed" ? (
            <AdminApiFailureNotice failure={saveState.failure} returnTo={RETURN_TO} testId="admin-product-research-scout-settings-failure" />
          ) : null}
        </section>

        <section className={CARD}>
          <h2 className="text-[15px] font-bold text-zinc-50">{m.usageHeading}</h2>
          <p className="mt-3 text-3xl font-bold tabular-nums text-zinc-50">{fill(m.usageValue, { calls: used, cap })}</p>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={cap}
            aria-valuenow={Math.min(used, cap)}
            aria-label={m.usageHeading}
          >
            <div className={`h-full rounded-full ${ratio >= 1 ? "bg-amber-500" : "bg-blue-500"}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
          <p className="mt-3 text-xs text-zinc-400">
            {fill(m.usageTokens, { input: number(initial.usageToday.inputTokens), output: number(initial.usageToday.outputTokens) })}
          </p>
          <p className="mt-1 text-xs text-zinc-400">{m.usageCapNote}</p>
        </section>
      </div>

      <section className={CARD}>
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-[15px] font-bold text-zinc-50">{m.daysHeading}</h2>
          <p className="text-xs text-zinc-500">{m.daysNote}</p>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs text-zinc-400">
              <tr className="border-b border-zinc-700">
                <th className="py-2 pr-3 font-medium">{m.dayColumn}</th>
                <th className="py-2 pr-3 text-right font-medium">{m.callsColumn}</th>
                <th className="py-2 pr-3 text-right font-medium">{m.failedColumn}</th>
                <th className="py-2 pr-3 text-right font-medium">{m.keptColumn}</th>
                <th className="py-2 pr-3 text-right font-medium">{m.inputColumn}</th>
                <th className="py-2 text-right font-medium">{m.outputColumn}</th>
              </tr>
            </thead>
            <tbody>
              {initial.days.map((day) => (
                <tr key={day.day} className="border-t border-zinc-800" data-testid="admin-product-research-scout-day">
                  <td className="py-2.5 pr-3 font-mono text-xs text-zinc-200">
                    {day.day} {day.day === todayKey ? <span className="font-sans text-zinc-400">{m.today}</span> : null}
                  </td>
                  {day.calls === 0 ? (
                    <td colSpan={5} className="py-2.5 text-right text-xs text-zinc-500">
                      {m.noRun}
                    </td>
                  ) : (
                    <>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-200">{day.calls}</td>
                      <td className={`py-2.5 pr-3 text-right font-mono tabular-nums ${day.failed > 0 ? "text-amber-300" : "text-zinc-200"}`}>
                        {day.failed}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-200">{day.kept}</td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-zinc-200">{number(day.inputTokens)}</td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-zinc-200">{number(day.outputTokens)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
