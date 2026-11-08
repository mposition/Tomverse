"use client";

import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminBars, AdminRing } from "@/components/admin/ui/AdminCharts";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminProductResearchScoutMessages } from "@/lib/adminMessages/productResearchScout";
import { adminScoutAgentMessages } from "@/lib/adminMessages/scoutAgent";
import { localTime } from "@/lib/adminScoutDisplay";
import type { ScoutConsoleView } from "@/lib/productResearchScoutConsoleRead";
import type { ScoutDaySummary } from "@/lib/productResearchScoutCore";

/**
 * The side tiles beside the Scout's suggestions: suggestions kept each day for
 * the last seven days, today's calls against the daily limit, and the last run.
 *
 * The Scout records calls and tokens, never dollars, so the ring is calls
 * against the daily limit and says so. `week` is null when the day counts
 * could not be read, and the tile then says that instead of drawing a flat
 * chart.
 */
export function ScoutAgentAside({
  initial,
  week,
}: {
  initial: ScoutConsoleView;
  /** Newest first, as `scoutDays` returns it; null when it could not be read. */
  week: readonly ScoutDaySummary[] | null;
}) {
  const m = useAdminMessages(adminScoutAgentMessages);
  const words = useAdminMessages(adminProductResearchScoutMessages);
  const { locale } = useAdminLocale();
  const oldestFirst = week ? [...week].reverse() : null;
  const total = oldestFirst ? oldestFirst.reduce((sum, day) => sum + day.kept, 0) : null;
  const cap = initial.settings.dailyCallCap;
  const used = initial.usageToday.calls;
  const fraction = cap > 0 ? Math.min(1, used / cap) : null;
  const lastRun = initial.lastRun;

  return (
    <aside className="flex min-w-0 flex-col gap-5" data-testid="scout-agent-aside">
      <AdminTile title={m.weekTitle}>
        {oldestFirst === null || total === null ? (
          <AdminStateBlock kind="error" title={m.weekNone} />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-4xl font-bold tabular-nums text-white">{total}</p>
              <AdminStatusChip tone="ok">{m.weekSent(initial.counts.sent)}</AdminStatusChip>
            </div>
            <AdminBars
              values={oldestFirst.map((day) => day.kept)}
              width={320}
              height={72}
              color="emerald"
              highlight={oldestFirst.length - 1}
              label={m.weekBarsLabel}
              className="w-full"
            />
          </>
        )}
      </AdminTile>

      <AdminTile title={m.costTitle} data-testid="scout-agent-cost">
        <div className="flex items-center gap-4">
          {fraction !== null ? (
            <AdminRing fraction={fraction} size={72} stroke={9} color={fraction >= 1 ? "amber" : "emerald"} label={m.costTitle}>
              <span className="text-sm font-bold tabular-nums text-white">{Math.round(fraction * 100)}%</span>
            </AdminRing>
          ) : null}
          <div className="min-w-0">
            <p className="text-2xl font-bold tabular-nums text-white">
              {used} / {cap}
            </p>
            <p className="text-xs text-zinc-400">{cap > 0 ? m.costOf(cap) : m.costOff}</p>
          </div>
        </div>
        <p className="text-xs text-zinc-500">{m.costNote}</p>
      </AdminTile>

      <AdminTile title={m.lastRunTitle}>
        {lastRun === null ? (
          <AdminStateBlock kind="empty" title={m.lastRunNone} />
        ) : (
          <div className="grid gap-1">
            <p className="text-sm font-semibold text-zinc-100">
              <time dateTime={lastRun.endedAt} suppressHydrationWarning>
                {localTime(lastRun.endedAt, locale, { today: words.todayWord, tomorrow: words.tomorrowWord })}
              </time>{" "}
              <span className="text-xs font-normal text-zinc-500">AEST</span>
            </p>
            <p className={`text-xs ${lastRun.failed > 0 ? "text-amber-300" : "text-zinc-400"}`}>
              {m.lastRunDetail(lastRun.calls, lastRun.failed, lastRun.kept)}
            </p>
            {lastRun.unsettled > 0 ? <p className="text-xs text-amber-300">{m.lastRunUnsettled(lastRun.unsettled)}</p> : null}
          </div>
        )}
      </AdminTile>
    </aside>
  );
}
