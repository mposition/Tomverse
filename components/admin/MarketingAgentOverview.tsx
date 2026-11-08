"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { MarketingCardFormat } from "@/components/admin/MarketingApprovalCard";
import { AdminBars, AdminRing } from "@/components/admin/ui/AdminCharts";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminMarketingAgentMessages } from "@/lib/adminMessages/marketingAgent";
import type { MarketingAgentOverview as MarketingAgentOverviewData } from "@/lib/marketingAgentOverviewCore";
import type { MarketingConsoleOverview } from "@/lib/marketingConsoleOverview";

/**
 * The stored cap ("20", "0.5") in millionths of a dollar, or null when it is not a plain positive decimal.
 * The ledger's own parser is not imported here: it sits in a module that pulls in node:crypto, which a
 * client bundle cannot take. A malformed cap is "no readable limit", never a half-parsed number.
 */
const capMicroUsd = (raw: string): number | null => {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/u.exec(raw.trim());
  if (!match) return null;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] || "").padEnd(6, "0") || "0");
  return micro > 0 ? micro : null;
};

const usd = (micro: number) => `US$ ${(micro / 1_000_000).toFixed(2)}`;

/**
 * The Marketing agent's Overview tab: posts waiting for a person, what is
 * scheduled, how many posts were written each day, this month's cost against
 * its limit and the generator's latest runs.
 *
 * Every part says when it could not be read: an unread count is not "nothing
 * waiting", and an unread month is not "no cost" (IA contract, rule 8). The
 * waiting cards come from the panel, which builds each one with the row's own
 * controls, so approving here goes through the same routes as the approval tab.
 */
export function MarketingAgentOverview({
  overview,
  agent,
  monthlyCapUsd,
  model,
  pendingCards,
  format,
}: {
  overview: MarketingConsoleOverview;
  agent: MarketingAgentOverviewData;
  /** The monthly cap as the settings document stores it, or null when none. */
  monthlyCapUsd: string | null;
  model: string | null;
  /** One compact card per waiting post, or null when the waiting posts could not be read. */
  pendingCards: ReactNode[] | null;
  format: MarketingCardFormat;
}) {
  const m = useAdminMessages(adminMarketingAgentMessages);
  const capMicro = monthlyCapUsd === null ? null : capMicroUsd(monthlyCapUsd);
  const spent = overview.llm?.countedMicroUsd ?? null;
  const fraction = spent !== null && capMicro ? Math.min(1, spent / capMicro) : null;
  const ringColor = fraction === null ? "blue" : fraction >= 0.9 ? "red" : fraction >= 0.7 ? "amber" : "emerald";
  const week = agent.week;
  const delta = week ? week.total - week.previousTotal : null;

  return (
    <div data-testid="marketing-agent-overview" className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <AdminTile
          data-testid="marketing-overview-pending"
          title={m.waitingTitle}
          description={m.waitingDetail}
          action={
            <Link
              href="/admin/marketing?tab=queue"
              className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-blue-300 hover:underline"
            >
              {m.waitingAll}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          }
        >
          {pendingCards === null || overview.pending === null ? (
            <AdminStateBlock kind="error" title={m.waitingUnread} />
          ) : pendingCards.length === 0 && overview.pending.count > 0 ? (
            // The cards come from the newest rows the tab read; the count is the whole queue.
            <p
              data-testid="marketing-pending-elsewhere"
              className="rounded-2xl border border-amber-500/40 p-4 text-sm text-amber-300"
            >
              {m.waitingElsewhere(overview.pending.count)}
            </p>
          ) : pendingCards.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.waitingNone} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{pendingCards}</div>
          )}
        </AdminTile>

        <AdminTile title={m.scheduledTitle} description={m.scheduledDetail}>
          {agent.scheduled === null ? (
            <AdminStateBlock kind="error" title={m.scheduledUnread} />
          ) : agent.scheduled.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.scheduledNone} />
          ) : (
            <ul data-testid="marketing-scheduled-list" className="grid gap-3 sm:grid-cols-2">
              {agent.scheduled.map((post) => (
                <li key={post.id} className="flex min-w-0 items-center gap-3 rounded-2xl border border-zinc-800 p-3">
                  <span className="flex shrink-0 flex-col items-center rounded-xl bg-amber-500/15 px-3 py-2 text-center text-amber-300">
                    <span className="text-[11px] font-bold">{(format.stamp(post.scheduledAt) ?? "").slice(5, 10)}</span>
                    <span className="text-base font-bold tabular-nums">
                      {(format.stamp(post.scheduledAt) ?? "").slice(11, 16)}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <span className="font-bold text-zinc-200">{format.channelName(post.channel)}</span>
                      <span className="font-mono uppercase">{post.locale}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-sm font-semibold text-zinc-100">
                      {post.excerpt ?? post.accountSlug}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminTile>
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <AdminTile title={m.weekTitle} data-testid="marketing-week-posts">
          {week === null ? (
            <AdminStateBlock kind="error" title={m.weekNone} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-4xl font-bold tabular-nums text-white">{week.total}</p>
                {delta !== null ? (
                  <AdminStatusChip tone={delta > 0 ? "ok" : "idle"}>{m.weekDelta(delta)}</AdminStatusChip>
                ) : null}
              </div>
              <AdminBars
                values={week.days.map((day) => day.count)}
                width={320}
                height={72}
                color="amber"
                highlight={week.days.length - 1}
                label={m.weekTitle}
                className="w-full"
              />
              <ol className="flex justify-between text-[11px] text-zinc-500" aria-hidden>
                {week.days.map((day) => (
                  <li key={day.date}>{m.weekday(new Date(`${day.date}T00:00:00Z`).getUTCDay())}</li>
                ))}
              </ol>
            </>
          )}
        </AdminTile>

        <AdminTile title={m.costTitle} data-testid="marketing-overview-spend">
          {spent === null ? (
            <AdminStateBlock kind="error" title={m.costUnread} />
          ) : (
            <div className="flex items-center gap-4">
              {fraction !== null ? (
                <AdminRing fraction={fraction} size={72} stroke={9} color={ringColor} label={m.costTitle}>
                  <span className="text-sm font-bold tabular-nums text-white">{Math.round(fraction * 100)}%</span>
                </AdminRing>
              ) : null}
              <div className="min-w-0">
                <p className="text-2xl font-bold tabular-nums text-white">{usd(spent)}</p>
                <p className="text-xs text-zinc-400">
                  {capMicro !== null ? m.costOf(usd(capMicro)) : m.costNoCap}
                </p>
                <p className="text-xs text-zinc-500">{m.costCalls(overview.llm?.calls ?? 0)}</p>
              </div>
            </div>
          )}
        </AdminTile>

        <AdminTile title={m.runsTitle} data-testid="marketing-recent-runs">
          {agent.runs === null ? (
            <AdminStateBlock kind="error" title={m.runsUnread} />
          ) : agent.runs.length === 0 ? (
            <AdminStateBlock kind="empty" title={m.runsNone} />
          ) : (
            <ul className="divide-y divide-zinc-800">
              {agent.runs.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-zinc-100">{m.runCalls(run.calls)}</span>
                    <span className="block text-xs text-zinc-500">{format.stamp(run.at)}</span>
                    {run.unsettled > 0 ? <span className="block text-xs text-amber-300">{m.runUnsettled}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-400">{usd(run.countedMicroUsd)}</span>
                </li>
              ))}
            </ul>
          )}
        </AdminTile>
      </div>

      <div className="xl:col-span-2">
        <AdminTechInfo summary={m.techSummary}>
          <dl className="grid gap-1">
            <div>
              {m.techEnvironment}: {overview.environment}
            </div>
            <div>
              {m.techModel}: {model ?? m.notSet}
            </div>
            {(agent.runs ?? []).map((run) => (
              <div key={run.id}>
                {m.techRunId}: {run.id}
              </div>
            ))}
          </dl>
        </AdminTechInfo>
      </div>
    </div>
  );
}
