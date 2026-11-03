"use client";

import { useCallback, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { MarketingBriefReport } from "@/components/admin/MarketingAnalysis";
import { brisbaneStamp } from "@/components/admin/MarketingMorning";
import { MarketingStrategyView } from "@/components/admin/MarketingStrategy";
import { adminFetch } from "@/lib/adminFetch";
import { adminMarketingReportsMessages } from "@/lib/adminMessages/marketingReports";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { MarketingWeeklyReport } from "@/lib/marketingWeeklyReportRead";

/**
 * The weekly marketing report (owner request 2026-11-03): one Brisbane week
 * on one page, assembled by the server when read
 * (lib/marketingWeeklyReportRead.ts). Opens on the last full week; the
 * operator steps back and forward a week at a time.
 */

type Load = { status: "loading" } | { status: "failed" } | { status: "ready"; report: MarketingWeeklyReport };

const HEAD = "py-1.5 pr-4 text-left text-xs font-medium text-zinc-500";
const CELL = "py-1.5 pr-4 text-[13px] text-zinc-200";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold text-white">{value}</p>
      {note ? <p className="text-[11px] text-sky-300">{note}</p> : null}
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="grid gap-2 border-t border-zinc-800 pt-4" data-testid={testId}>
      <h4 className="text-sm font-semibold text-zinc-100">{title}</h4>
      {children}
    </section>
  );
}

const minutes = (ms: number | null) => (ms === null ? null : `${Math.round(ms / 60_000)}m`);

export function MarketingWeeklyReportView({ report }: { report: MarketingWeeklyReport }) {
  const m = useAdminMessages(adminMarketingReportsMessages);
  const x = report.measurement;
  const held = (key: "success_rate" | "latency" | "signups") => x.held.includes(key);
  const pair = (value: { total: number; attributed: number } | null) =>
    value === null ? m.unreadable : `${value.attributed} / ${value.total}`;
  return (
    <div className="grid gap-4">
      <Section title={m.secPosts} testId="marketing-weekly-posts">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={m.drafts} value={String(x.drafts.created)} />
          <Stat label={m.approved} value={String(x.decisions.approved)} />
          <Stat label={m.rejected} value={String(x.decisions.rejected)} />
          <Stat label={m.published} value={String(x.publishedInWindow)} />
        </div>
        <p className="text-xs text-zinc-400">
          {m.queueNow
            .replace("{pending}", String(x.queue.pendingApproval))
            .replace("{approved}", String(x.queue.approvedWaiting))
            .replace("{scheduled}", String(x.queue.scheduled))}
        </p>
        {x.drafts.guardCodes.length > 0 ? (
          <p className="text-xs text-zinc-400">
            {m.guardCodes}:{" "}
            <span className="font-mono text-zinc-300">
              {x.drafts.guardCodes.map((entry) => `${entry.code} ${entry.count}`).join(" · ")}
            </span>
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className={HEAD}>{m.colAccount}</th>
                <th className={HEAD}>{m.colStatus}</th>
                <th className={HEAD}>{m.published}</th>
                <th className={HEAD}>{m.pendingNow}</th>
              </tr>
            </thead>
            <tbody>
              {x.accounts.map((account) => (
                <tr key={account.accountSlug} className="border-b border-zinc-800/60">
                  <td className={`${CELL} font-mono text-xs`}>{account.accountSlug}</td>
                  <td className={`${CELL} font-mono text-xs text-zinc-400`}>
                    {account.status}
                    {account.pauseReasonCode ? ` · ${account.pauseReasonCode}` : ""}
                  </td>
                  <td className={CELL}>{account.published}</td>
                  <td className={CELL}>{account.pendingApproval + account.approvedWaiting}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={m.secMeasurement} testId="marketing-weekly-measurement">
        {x.dispatch.compacted ? (
          <p className="text-sm text-sky-300" data-testid="marketing-weekly-compacted">
            {m.compacted}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label={m.successRate}
            value={x.dispatch.successRate === null ? "—" : `${Math.round(x.dispatch.successRate * 100)}%`}
            note={held("success_rate") ? `${m.held} · ${m.heldSent}` : undefined}
          />
          <Stat label={m.verified} value={`${x.dispatch.verified} / ${x.dispatch.sent}`} />
          <Stat
            label={m.latency}
            value={held("latency") ? "—" : `${minutes(x.dispatch.latencyP50Ms)} / ${minutes(x.dispatch.latencyP95Ms)}`}
            note={held("latency") ? `${m.held} · ${m.heldLatency}` : undefined}
          />
          <Stat label={m.outcomeUnknown} value={String(x.dispatch.outcomeUnknown)} />
          <Stat
            label={m.signups}
            value={pair(x.signups)}
            note={held("signups") ? `${m.held} · ${m.heldSignups}` : undefined}
          />
          <Stat label={m.leads} value={pair(x.guestLeads)} />
          <Stat label={m.touches} value={x.touches === null ? m.unreadable : String(x.touches)} />
          <Stat
            label={m.llm}
            value={
              x.llm === null
                ? m.unreadable
                : `US$${(x.llm.countedMicroUsd / 1_000_000).toFixed(2)}${x.llm.capUsd === null ? "" : ` / US$${x.llm.capUsd.toFixed(2)}`}`
            }
          />
        </div>
        <p className="text-xs text-zinc-400">
          {m.failures}:{" "}
          {x.dispatch.failuresByCode.length === 0 ? (
            m.none
          ) : (
            <span className="font-mono text-zinc-300">
              {x.dispatch.failuresByCode.map((entry) => `${entry.code} ${entry.count}`).join(" · ")}
            </span>
          )}
          {x.dispatch.notSent > 0 ? ` · ${m.notSent.replace("{count}", String(x.dispatch.notSent))}` : ""}
        </p>
        <p className="text-xs text-zinc-400">
          {m.inFlight.replace("{count}", String(x.dispatch.inFlight))}
        </p>
        {x.dispatch.segments.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse" data-testid="marketing-weekly-segments">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className={HEAD}>{m.colAccount}</th>
                  <th className={HEAD}>{m.colMode}</th>
                  <th className={HEAD}>{m.colSent}</th>
                  <th className={HEAD}>{m.published}</th>
                  <th className={HEAD}>{m.failed}</th>
                  <th className={HEAD}>{m.successRate}</th>
                  <th className={HEAD}>{m.latency}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...x.dispatch.byMode.map((row) => ({ ...row, accountSlug: "*" })),
                  ...x.dispatch.segments,
                ].map((row) => (
                  <tr key={`${row.mode}|${row.accountSlug}`} className="border-b border-zinc-800/60">
                    <td className={`${CELL} font-mono text-xs`}>{row.accountSlug}</td>
                    <td className={`${CELL} font-mono text-xs`}>{row.mode}</td>
                    <td className={CELL}>{row.sent}</td>
                    <td className={CELL}>{row.published}</td>
                    <td className={CELL}>{row.failed}</td>
                    <td className={CELL}>
                      {row.successRate === null ? <span className="text-sky-300">{m.held}</span> : `${Math.round(row.successRate * 100)}%`}
                    </td>
                    <td className={CELL}>
                      {row.latencyP50Ms === null ? (
                        <span className="text-sky-300">{m.held}</span>
                      ) : (
                        `${minutes(row.latencyP50Ms)} / ${minutes(row.latencyP95Ms)}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {x.signupChannels && x.signupChannels.length > 0 ? (
          <ul className="grid gap-0.5 text-xs text-zinc-400" data-testid="marketing-weekly-signup-channels">
            {x.signupChannels.map((channel) => (
              <li key={`${channel.source}|${channel.medium}|${channel.campaign}`}>
                <span className="font-mono text-zinc-300">
                  {channel.source} / {channel.medium} / {channel.campaign}
                </span>{" "}
                {channel.attributed}
                {channel.held ? <span className="ml-1 text-sky-300">{m.held}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title={m.secFunnel} testId="marketing-weekly-funnel">
        <p className="text-sm text-zinc-400">{m.funnelNotConnected}</p>
      </Section>

      <Section title={m.secAnalysis} testId="marketing-weekly-analysis">
        {report.analysis ? (
          <>
            <p className="text-xs text-zinc-500">{m.written.replace("{time}", brisbaneStamp(report.analysis.createdAt))}</p>
            <MarketingBriefReport
              report={{
                payload: { topicIds: [report.analysis.topicId], claimIds: report.analysis.claimIds },
                analysis: { ...report.analysis, strategy: undefined, morning: undefined },
              }}
            />
          </>
        ) : (
          <p className="text-sm text-zinc-400">{m.noAnalysis}</p>
        )}
      </Section>

      <Section title={m.secStrategy} testId="marketing-weekly-strategy">
        {report.strategy ? <MarketingStrategyView strategy={report.strategy} /> : <p className="text-sm text-zinc-400">{m.noStrategy}</p>}
      </Section>

      <Section title={m.secIntel} testId="marketing-weekly-intel">
        <p className="text-sm text-zinc-300">
          {report.marketIntel.reports === 0 || report.marketIntel.latestAt === null
            ? m.noIntel
            : m.intelSummary
                .replace("{reports}", String(report.marketIntel.reports))
                .replace("{time}", brisbaneStamp(report.marketIntel.latestAt))
                .replace("{kept}", String(report.marketIntel.factsKept ?? "—"))
                .replace("{dropped}", String(report.marketIntel.factsDropped ?? "—"))}
        </p>
      </Section>

      <Section title={m.secExperiments} testId="marketing-weekly-experiments">
        <p className="text-sm text-zinc-300">
          {report.experiments.results === 0
            ? m.noExperiments
            : m.experimentsSummary.replace("{count}", String(report.experiments.results))}
        </p>
      </Section>
    </div>
  );
}

/** The weekly report card in the Reports tab, a week at a time. */
export function MarketingWeeklyReportCard() {
  const m = useAdminMessages(adminMarketingReportsMessages);
  const [week, setWeek] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const read = useCallback(async (target: string | null) => {
    setLoad({ status: "loading" });
    try {
      const query = target ? `?week=${encodeURIComponent(target)}` : "";
      const response = await adminFetch(`/api/admin/marketing/weekly-report${query}`, { cache: "no-store" });
      if (!response.ok) {
        await discardResponseBody(response);
        setLoad({ status: "failed" });
        return;
      }
      const report = (await response.json()) as MarketingWeeklyReport;
      setLoad(report?.measurement && typeof report.weekStart === "string" ? { status: "ready", report } : { status: "failed" });
    } catch {
      setLoad({ status: "failed" });
    }
  }, []);

  useEffect(() => {
    // From a microtask, as the other admin panels do.
    void Promise.resolve().then(() => read(week));
  }, [read, week]);

  const report = load.status === "ready" ? load.report : null;
  const button =
    "inline-flex min-h-10 items-center rounded-lg border border-zinc-700 px-3 text-[13px] font-semibold text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <section data-testid="marketing-weekly-report-card" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-white">
          {m.weeklyTitle}
          {report ? (
            <span className="ml-2 text-sm font-normal text-zinc-400">
              {m.weeklyRange.replace("{start}", report.weekStart).replace("{end}", report.weekEnd)}
              {report.inProgress ? ` · ${m.weeklyInProgress}` : ""}
            </span>
          ) : null}
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            className={button}
            disabled={!report}
            onClick={() => report && setWeek(report.previousWeekStart)}
          >
            {m.weeklyPrevious}
          </button>
          <button
            type="button"
            className={button}
            disabled={!report?.nextWeekStart}
            onClick={() => report?.nextWeekStart && setWeek(report.nextWeekStart)}
          >
            {m.weeklyNext}
          </button>
        </div>
      </div>
      {report ? (
        <p className="mt-1 text-xs text-zinc-500">{report.weeklyKpiRecorded ? m.weeklyKpiRecorded : m.weeklyKpiPending}</p>
      ) : null}
      <div className="mt-3">
        {load.status === "loading" ? (
          <p className="text-sm text-zinc-400">{m.loading}</p>
        ) : load.status === "failed" ? (
          <p className="text-sm text-amber-300">{m.loadFailed}</p>
        ) : (
          <MarketingWeeklyReportView report={load.report} />
        )}
      </div>
    </section>
  );
}
