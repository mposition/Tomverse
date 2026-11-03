"use client";

import { useCallback, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { MarketingActionRail, type MarketingAction } from "@/components/admin/MarketingActions";
import { MarketingMorningView } from "@/components/admin/MarketingMorning";
import { MarketingStrategyView } from "@/components/admin/MarketingStrategy";
import { adminFetch } from "@/lib/adminFetch";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";
import { adminMarketingAnalysisMessages } from "@/lib/adminMessages/marketingAnalysis";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { MarketingAnalysisSourceView, MarketingAnalysisView } from "@/lib/marketingAnalysisCore";
import { isHttpsUrl } from "@/lib/marketingReportView";

/**
 * The market analysis and weekly brief (operator decision 2026-11-01): the
 * switch that lets the generator spend on it, and how a brief report reads.
 * Apart from AdminMarketingPanel so the panel changes by a few lines.
 */

type SwitchRead = { enabled: boolean; version: string | null };

const tagClass = (on: boolean) =>
  `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
    on ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-300"
  }`;

/**
 * The switch, read from its own route so the console loader is unchanged.
 * Turning it on asks first; turning it off does not, because stopping spend is
 * never the thing to slow down.
 */
export function MarketingAnalysisSwitch({ section, canWrite }: { section: string; canWrite: boolean }) {
  const m = useAdminMessages(adminMarketingMessages);
  const a = useAdminMessages(adminMarketingAnalysisMessages);
  const [read, setRead] = useState<SwitchRead | "loading" | "unreadable">("loading");

  const load = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/marketing/analysis-settings/state", { cache: "no-store" });
      if (!response.ok) {
        await discardResponseBody(response);
        setRead("unreadable");
        return;
      }
      const body = (await response.json()) as SwitchRead;
      setRead(typeof body.enabled === "boolean" ? body : "unreadable");
    } catch {
      setRead("unreadable");
    }
  }, []);

  useEffect(() => {
    // From a microtask, as the other admin panels do: the load sets state only
    // after its request answers, never inside the effect body itself.
    void Promise.resolve().then(() => load());
  }, [load]);

  const state = typeof read === "object" ? read : null;
  const action: MarketingAction | null =
    canWrite && state
      ? {
          id: "analysis-switch",
          label: state.enabled ? a.turnOff : a.turnOn,
          path: "/api/admin/marketing/analysis-settings",
          method: "PATCH",
          checked: state.enabled,
          confirm: state.enabled ? undefined : a.confirmOn,
          body: () => ({ enabled: !state.enabled, expectedVersion: state.version }),
        }
      : null;

  return (
    <div data-testid="marketing-analysis-switch" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-white">{a.switchTitle}</h3>
            <span data-state={state ? (state.enabled ? "on" : "off") : read} className={tagClass(state?.enabled === true)}>
              {read === "loading" ? a.loading : !state ? a.switchUnreadable : state.enabled ? a.switchOn : a.switchOff}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">{a.switchHint}</p>
        </div>
        {action ? (
          <MarketingActionRail actions={[action]} section={section} onDone={() => void load()} m={m} appearance="switch" />
        ) : null}
      </div>
    </div>
  );
}

function Sources({ sources, label }: { sources: readonly MarketingAnalysisSourceView[]; label: string }) {
  if (sources.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-x-2 text-xs">
      {sources.map((source, index) =>
        // A link only when the server judged it one (https on an approved
        // competitor host) and it still reads as https here; anything else,
        // including a page the model made up, is text.
        source.linkable && isHttpsUrl(source.url) ? (
          <a
            key={`${source.url}:${index}`}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="break-all text-zinc-300 underline underline-offset-2 hover:text-white"
            data-testid="marketing-analysis-source-link"
          >
            {label}
          </a>
        ) : (
          <span key={`${source.url}:${index}`} className="break-all text-zinc-500" data-testid="marketing-analysis-source-text">
            {source.url}
          </span>
        ),
      )}
    </span>
  );
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-400">{title}</p>
      <ul className="mt-1 grid list-disc gap-1 pl-5 text-[13px] leading-5 text-zinc-200">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** What a brief report says: the topic and claims A5 was given, and the analysis behind them. */
export function MarketingBriefReport({
  report,
}: {
  report: { payload: unknown; analysis?: MarketingAnalysisView | null };
}) {
  const a = useAdminMessages(adminMarketingAnalysisMessages);
  const payload = report.payload as { topicIds?: string[]; claimIds?: string[] };
  const analysis = report.analysis ?? null;
  const points = (title: string, entries: MarketingAnalysisView["competitive"]["ahead"]) => (
    <div>
      <p className="text-xs font-medium text-zinc-400">{title}</p>
      {entries.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-500">{a.noPoints}</p>
      ) : (
        <ul className="mt-1 grid list-disc gap-1 pl-5 text-[13px] leading-5 text-zinc-200">
          {entries.map((entry, index) => (
            <li key={index}>
              {entry.point}
              <Sources sources={entry.sources} label={a.source} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="grid gap-4" data-testid="marketing-report-brief">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-zinc-400">{a.topic}</p>
          <p className="mt-1 font-mono text-[13px] text-zinc-100">{(payload.topicIds ?? []).join(", ") || "-"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-zinc-400">{a.claims}</p>
          <p className="mt-1 break-all font-mono text-[13px] text-zinc-100">{(payload.claimIds ?? []).join(", ") || "-"}</p>
        </div>
      </div>
      {analysis?.morning ? <MarketingMorningView morning={analysis.morning} /> : null}
      {analysis?.strategy ? <MarketingStrategyView strategy={analysis.strategy} /> : null}
      {analysis === null ? (
        <p className="text-sm text-zinc-400">{a.noAnalysis}</p>
      ) : (
        <>
          <section className="grid gap-3" data-testid="marketing-analysis-self">
            <h4 className="text-sm font-semibold text-zinc-100">{a.whatItIs}</h4>
            <p className="text-[13px] leading-5 text-zinc-200">{analysis.self.summary}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <List title={a.strengths} items={analysis.self.strengths} />
              <List title={a.weaknesses} items={analysis.self.weaknesses} />
              <List title={a.audiences} items={analysis.self.audiences} />
            </div>
          </section>
          <section className="grid gap-3 border-t border-zinc-800 pt-4" data-testid="marketing-analysis-competitive">
            <div>
              <h4 className="text-sm font-semibold text-zinc-100">{a.pricePosition}</h4>
              <p className="mt-1 text-[13px] leading-5 text-zinc-200">{analysis.competitive.pricePosition}</p>
            </div>
            {points(a.ahead, analysis.competitive.ahead)}
            {points(a.behind, analysis.competitive.behind)}
            <div>
              <h4 className="text-sm font-semibold text-zinc-100">{a.weeklyMessage}</h4>
              <p className="mt-1 text-[13px] leading-5 text-zinc-200">{analysis.competitive.weeklyMessage}</p>
            </div>
          </section>
          <p className="text-xs text-zinc-500">
            {a.basis
              .replace("{facts}", String(analysis.factCount))
              .replace("{features}", String(analysis.featureCount))
              .replace("{competitors}", String(analysis.competitorIds.length))
              .replace("{version}", analysis.promptVersion)}
          </p>
        </>
      )}
    </div>
  );
}
