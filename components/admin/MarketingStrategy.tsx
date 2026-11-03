"use client";

import { useCallback, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminMarketingAnalysisMessages } from "@/lib/adminMessages/marketingAnalysis";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { MarketingStrategyDay, MarketingWeeklyStrategy } from "@/lib/marketingAnalysisCore";

/**
 * The weekly marketing strategy (owner request 2026-11-03): the plan the
 * first generator run of a week writes (lib/marketingStrategyCore.ts), drawn
 * at the top of the Reports tab and inside the brief it came with. Apart from
 * AdminMarketingPanel so the panel changes by a few lines.
 */

const DAYS: readonly MarketingStrategyDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

type DayLabels = Record<"dayMon" | "dayTue" | "dayWed" | "dayThu" | "dayFri" | "daySat" | "daySun", string>;

const dayLabel = (a: DayLabels, day: MarketingStrategyDay) =>
  ({ mon: a.dayMon, tue: a.dayTue, wed: a.dayWed, thu: a.dayThu, fri: a.dayFri, sat: a.daySat, sun: a.daySun })[day];

const HEAD = "py-1.5 pr-4 text-left text-xs font-medium text-zinc-500";
const CELL = "py-2 pr-4 align-top text-[13px] leading-5 text-zinc-200";

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

/** One week's plan: the strategy, the goal, and what each account posts on which days. */
export function MarketingStrategyView({ strategy }: { strategy: MarketingWeeklyStrategy }) {
  const a = useAdminMessages(adminMarketingAnalysisMessages);
  return (
    <div className="grid gap-4" data-testid="marketing-strategy">
      <div className="rounded-xl border-l-4 border-violet-400 bg-zinc-950/60 px-4 py-3">
        <p className="text-[15px] font-semibold leading-6 text-white">{strategy.headline}</p>
        <p className="mt-1 text-[13px] leading-5 text-zinc-400">
          <span className="font-medium text-zinc-300">{a.strategyRationale}</span> · {strategy.rationale}
        </p>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">{a.strategyGoal}</h4>
        <p className="mt-1 text-[13px] leading-5 text-zinc-200">{strategy.goal}</p>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">{a.strategyAccounts}</h4>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse" data-testid="marketing-strategy-accounts">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className={HEAD}>{a.colAccount}</th>
                <th className={HEAD}>{a.colRole}</th>
                <th className={HEAD}>{a.colAngle}</th>
                <th className={HEAD}>{a.colFormat}</th>
                <th className={HEAD}>{a.colPosts}</th>
                <th className={HEAD}>{a.colClaims}</th>
              </tr>
            </thead>
            <tbody>
              {strategy.accounts.map((plan) => (
                <tr key={plan.accountSlug} className="border-b border-zinc-800/60">
                  <td className={`${CELL} font-mono text-xs`}>{plan.accountSlug}</td>
                  <td className={CELL}>{plan.role}</td>
                  <td className={CELL}>{plan.angle}</td>
                  <td className={CELL}>{plan.format}</td>
                  <td className={`${CELL} whitespace-nowrap`}>
                    {plan.posts} · {plan.days.map((day) => dayLabel(a, day)).join(" ")}
                  </td>
                  <td className={`${CELL} break-all font-mono text-xs`}>{plan.claimIds.join(", ") || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h4 className="text-sm font-semibold text-zinc-100">{a.strategyCalendar}</h4>
        <div className="mt-1 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse" data-testid="marketing-strategy-calendar">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className={HEAD}>{a.colAccount}</th>
                {DAYS.map((day) => (
                  <th key={day} className={`${HEAD} text-center`}>
                    {dayLabel(a, day)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strategy.accounts.map((plan) => (
                <tr key={plan.accountSlug} className="border-b border-zinc-800/60">
                  <td className="py-1.5 pr-4 font-mono text-xs text-zinc-300">{plan.accountSlug}</td>
                  {DAYS.map((day) => (
                    <td key={day} className="py-1.5 text-center">
                      {plan.days.includes(day) ? (
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full bg-violet-400"
                          role="img"
                          aria-label={dayLabel(a, day)}
                        />
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {strategy.needs.length > 0 || strategy.avoid.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {strategy.needs.length > 0 ? <List title={a.strategyNeeds} items={strategy.needs} /> : null}
          {strategy.avoid.length > 0 ? <List title={a.strategyAvoid} items={strategy.avoid} /> : null}
        </div>
      ) : null}
      <p className="text-xs text-zinc-500">
        {a.strategyNote} · {strategy.promptVersion}
      </p>
    </div>
  );
}

type StrategyLoad =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "none" }
  | { status: "unreadable" }
  | { status: "found"; current: boolean; createdAt: string; strategy: MarketingWeeklyStrategy };

/** When a plan was written, on the operator's clock (Brisbane, no daylight saving). */
const brisbaneStamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16)} AEST`;
};

/** The newest weekly plan, at the top of the Reports tab. */
export function MarketingWeeklyStrategyCard() {
  const a = useAdminMessages(adminMarketingAnalysisMessages);
  const [load, setLoad] = useState<StrategyLoad>({ status: "loading" });

  const read = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/marketing/strategy", { cache: "no-store" });
      if (!response.ok) {
        await discardResponseBody(response);
        setLoad({ status: "failed" });
        return;
      }
      const body = (await response.json()) as StrategyLoad;
      setLoad(body.status === "found" || body.status === "none" || body.status === "unreadable" ? body : { status: "failed" });
    } catch {
      setLoad({ status: "failed" });
    }
  }, []);

  useEffect(() => {
    // From a microtask, as the other admin panels do: the load sets state only
    // after its request answers, never inside the effect body itself.
    void Promise.resolve().then(() => read());
  }, [read]);

  return (
    <section data-testid="marketing-strategy-card" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-white">
          {a.strategyTitle}
          {load.status === "found" ? (
            <span className="ml-2 text-sm font-normal text-zinc-400">
              {a.strategyWeek.replace("{start}", load.strategy.weekStart).replace("{end}", load.strategy.weekEnd)}
            </span>
          ) : null}
        </h3>
        {load.status === "found" ? (
          <span className="text-xs text-zinc-500">{a.strategyWritten.replace("{time}", brisbaneStamp(load.createdAt))}</span>
        ) : null}
      </div>
      <div className="mt-3">
        {load.status === "loading" ? (
          <p className="text-sm text-zinc-400">{a.strategyLoading}</p>
        ) : load.status === "failed" ? (
          <p className="text-sm text-amber-300">{a.strategyLoadFailed}</p>
        ) : load.status === "unreadable" ? (
          <p className="text-sm text-amber-300">{a.strategyUnreadable}</p>
        ) : load.status === "none" ? (
          <p className="text-sm text-zinc-400">{a.strategyNone}</p>
        ) : (
          <>
            {load.current ? null : (
              <p className="mb-3 text-sm text-amber-300" data-testid="marketing-strategy-stale">
                {a.strategyStale}
              </p>
            )}
            <MarketingStrategyView strategy={load.strategy} />
          </>
        )}
      </div>
    </section>
  );
}
