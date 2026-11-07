import Link from "next/link";
import { AlertTriangle, ArrowRight, Inbox } from "lucide-react";
import { AdminDecisionAvatar } from "@/components/admin/AdminDecisionAvatar";
import { AdminSnapshotActions } from "@/components/admin/AdminSnapshotActions";
import { AdminDonut, AdminRing } from "@/components/admin/ui/AdminCharts";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminProviderMark } from "@/components/admin/ui/AdminProviderMark";
import { AdminShareList } from "@/components/admin/ui/AdminShareList";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import {
  decisionAge,
  decisionSubtitle,
  decisionTitle,
  decisionWaitTone,
} from "@/lib/adminDecisionCopy";
import { DECISION_AREAS, type DecisionArea, type DecisionInbox } from "@/lib/adminDecisionInbox";
import type { AdminHomeTeam } from "@/lib/adminHomeAgents";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";
import { formatAestDateTime, type AdminChartColor, type AdminTone } from "@/lib/adminUiCore";

/**
 * Today: the greeting and what waits on the operator, four numbers, where the
 * decisions are, what the AI cost today, how the services are, and the
 * decisions to make now.
 *
 * Each fact appears once. The other numbers the page used to carry (plan mix,
 * promotions, churn watch, usage counts) belong to Metrics and their own
 * screens; the score's arithmetic is the Health score tab.
 *
 * A figure that could not be read is `null` and renders as unavailable, never
 * as a zero. A part whose read failed says so instead of drawing an empty
 * list.
 */

export type OverviewKpi = {
  label: string;
  /** Null when the read behind it failed. */
  value: string | null;
  detail: string;
  tone?: "neutral" | "warn" | "bad";
};

export type OverviewProviderCost = {
  provider: string;
  displayName: string;
  todayCostMicroUsd: number;
  status: "available" | "limited" | "outage";
};

export type OverviewServices = {
  providers: OverviewProviderCost[];
  /** Sum of the providers' daily budgets, or 0 when none is set. */
  dayBudgetMicroUsd: number;
};

const AREA_COLOR: Record<DecisionArea, AdminChartColor> = {
  customers: "emerald",
  agents: "violet",
  development: "blue",
  system: "amber",
};

// Static strings so Tailwind sees every class.
const AREA_DOT: Record<DecisionArea, string> = {
  customers: "bg-emerald-500",
  agents: "bg-violet-500",
  development: "bg-blue-500",
  system: "bg-amber-500",
};

const TONE_DOT: Record<AdminTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  info: "bg-blue-500",
  idle: "bg-zinc-500",
  unknown: "border border-dashed border-zinc-500",
};

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const brisbaneHour = (now: Date) =>
  Number(
    new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", hour: "2-digit", hourCycle: "h23" }).format(now)
  );

export async function AdminOverviewSummary({
  now,
  userName,
  unreadableReads,
  kpis,
  inbox,
  teams,
  services,
  alertFailureCount,
  blockingEnvCount,
  healthScore,
  healthScoreIncomplete,
  recentActivity,
  recentActivityLimit,
  snapshotReport,
}: {
  now: Date;
  userName: string | null;
  /** Human names of the page's reads that did not come back. */
  unreadableReads: string[];
  /** Four numbers at most. */
  kpis: OverviewKpi[];
  inbox: DecisionInbox;
  /** Null when the team status could not be read. */
  teams: AdminHomeTeam[] | null;
  /** Null when the provider dashboard could not be read. */
  services: OverviewServices | null;
  alertFailureCount: number | null;
  blockingEnvCount: number;
  healthScore: number;
  /** True when a score input could not be read, so the score is a ceiling. */
  healthScoreIncomplete: boolean;
  recentActivity: Array<{
    id: string;
    summary: string;
    actorEmail: string | null;
    action: string;
    createdAt: string;
  }>;
  recentActivityLimit: number;
  snapshotReport: string;
}) {
  const [home, { summary: s }] = await Promise.all([
    getAdminMessages(adminHomeMessages),
    getAdminMessages(adminOverviewMessages),
  ]);
  const t = home.today;

  const hour = brisbaneHour(now);
  const greeting =
    hour < 12 ? t.greeting.morning(userName) : hour < 18 ? t.greeting.afternoon(userName) : t.greeting.evening(userName);
  const dateLine = new Intl.DateTimeFormat(home.intlLocale, {
    timeZone: "Australia/Brisbane",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(now);

  const inboxUnknown = inbox.queueUnread && inbox.unreadSources.length > 0;
  const partial = inbox.queueUnread || inbox.failedCategories.length > 0 || inbox.unreadSources.length > 0;
  const oldestHours = Math.max(-1, ...Object.values(inbox.waitHours));
  const topItems = inbox.items.slice(0, 4);

  const areaSegments = DECISION_AREAS.filter((area) => inbox.byArea[area] > 0).map((area) => ({
    value: inbox.byArea[area],
    color: AREA_COLOR[area],
    label: home.areas[area],
  }));

  const costRows = services
    ? [...services.providers]
        .filter((provider) => provider.todayCostMicroUsd > 0)
        .sort((left, right) => right.todayCostMicroUsd - left.todayCostMicroUsd)
        .slice(0, 4)
    : [];
  const costTotal = services ? services.providers.reduce((sum, p) => sum + p.todayCostMicroUsd, 0) : 0;
  const costFraction =
    services && services.dayBudgetMicroUsd > 0 ? Math.min(1, costTotal / services.dayBudgetMicroUsd) : null;

  const providerTone = (status: OverviewProviderCost["status"]): AdminTone =>
    status === "outage" ? "bad" : status === "limited" ? "warn" : "ok";
  const notNormal = services ? services.providers.filter((p) => p.status !== "available") : [];
  const providersTone: AdminTone = services
    ? notNormal.some((p) => p.status === "outage")
      ? "bad"
      : notNormal.length > 0
        ? "warn"
        : "ok"
    : "unknown";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section
        data-testid="admin-overview-greeting"
        className="rounded-3xl border border-blue-500/20 bg-blue-500/10 p-5 sm:p-6"
      >
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-zinc-400">{dateLine}</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl">{greeting}</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-300" data-testid="admin-overview-decision-line">
              {inboxUnknown
                ? t.decisionsUnknown
                : inbox.total === 0
                  ? t.decisionsNone
                  : t.decisionsWaiting(inbox.total)}{" "}
              {!inboxUnknown && oldestHours >= 24 ? t.oldest(decisionAge(oldestHours, home)) : null}
            </p>
            {partial && !inboxUnknown ? (
              <p className="mt-1 text-xs text-amber-300">{t.decisionsPartial}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Link
                href="/admin/work-queue"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
              >
                <Inbox className="h-4 w-4" aria-hidden />
                {t.openDecisions}
              </Link>
              <Link
                href="/admin/office"
                className="inline-flex min-h-11 items-center text-sm font-bold text-blue-300 hover:text-blue-200"
              >
                {t.seeTeam}
              </Link>
              <AdminSnapshotActions report={snapshotReport} />
            </div>
          </div>
          {teams ? (
            <ul
              aria-label={t.teamLabel}
              className="grid grid-cols-5 gap-x-2 gap-y-3 self-start sm:grid-cols-9 xl:grid-cols-5 2xl:grid-cols-9"
            >
              {teams.map(({ team, tone }) => (
                <li key={team} className="flex min-w-0 flex-col items-center gap-1 text-center">
                  <AdminPixelAvatar team={team} unit={3} />
                  <span className="max-w-full truncate text-[11px] font-bold text-zinc-200">{home.teams[team]}</span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} />
                    {home.teamTone[tone]}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-amber-300">{t.teamUnread}</p>
          )}
        </div>
      </section>

      {unreadableReads.length > 0 ? (
        <div
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
          role="status"
          data-testid="admin-overview-unreadable-reads"
        >
          <p className="flex items-center gap-2 text-sm font-bold text-amber-100">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {s.readsFailedTitle(unreadableReads.length)}
          </p>
          <p className="mt-1 text-xs leading-5 text-amber-100/80">{s.readsFailedDetail(unreadableReads.join(", "))}</p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.slice(0, 4).map((kpi) => (
          <AdminKpiCard
            key={kpi.label}
            label={kpi.label}
            value={kpi.value}
            detail={kpi.detail}
            tone={kpi.tone}
          />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <AdminTile title={t.byArea.title} description={t.byArea.description}>
          {areaSegments.length === 0 ? (
            <AdminStateBlock
              kind={inbox.queueUnread ? "error" : "empty"}
              title={inbox.queueUnread ? s.unreadable : t.byArea.empty}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-6">
              <AdminDonut segments={areaSegments} size={132} stroke={16} label={t.byArea.title}>
                <span className="text-3xl font-black tabular-nums text-white">{inbox.total}</span>
                <span className="text-xs text-zinc-400">{t.byArea.unit}</span>
              </AdminDonut>
              <ul className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                {DECISION_AREAS.map((area) => (
                  <li key={area} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-zinc-300">
                      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-sm ${AREA_DOT[area]}`} />
                      <span className="truncate">{home.areas[area]}</span>
                    </span>
                    <span className="font-bold tabular-nums text-white">{inbox.byArea[area]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </AdminTile>

        <AdminTile title={t.cost.title} description={t.cost.description}>
          {!services ? (
            <AdminStateBlock kind="error" title={t.cost.unread} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-3xl font-black tabular-nums text-white">{money(costTotal)}</p>
                  {services.dayBudgetMicroUsd > 0 ? (
                    <p className="mt-1 text-xs text-zinc-500">{t.cost.limit(money(services.dayBudgetMicroUsd))}</p>
                  ) : null}
                </div>
                {costFraction !== null ? (
                  <AdminRing fraction={costFraction} size={64} stroke={8} color="blue" label={t.cost.usedOfLimit(Math.round(costFraction * 100))}>
                    <span className="text-xs font-bold text-zinc-200">{Math.round(costFraction * 100)}%</span>
                  </AdminRing>
                ) : null}
              </div>
              {costRows.length === 0 ? (
                <p className="text-sm text-zinc-500">{t.cost.empty}</p>
              ) : (
                <AdminShareList
                  rows={costRows.map((provider) => ({
                    key: provider.provider,
                    label: provider.displayName,
                    lead: <AdminProviderMark provider={provider.provider} size={22} />,
                    value: provider.todayCostMicroUsd,
                    valueLabel: money(provider.todayCostMicroUsd),
                  }))}
                />
              )}
            </>
          )}
        </AdminTile>

        <AdminTile
          title={t.service.title}
          description={t.service.description}
          action={
            services ? (
              <AdminStatusChip tone={providersTone}>
                {notNormal.length === 0 ? t.service.allGood : t.service.attention(notNormal.length)}
              </AdminStatusChip>
            ) : null
          }
        >
          <ul className="flex flex-col divide-y divide-zinc-800 text-sm">
            <li className="py-2.5 first:pt-0">
              <Link
                href="/admin/overview?tab=health"
                data-testid="admin-health-score-link"
                className="flex items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="block font-bold text-zinc-100">{t.service.health}</span>
                  <span className="block text-xs text-zinc-500">{t.service.healthValue(healthScore)}</span>
                  {healthScoreIncomplete ? (
                    <span className="block text-xs font-bold text-amber-300" data-testid="admin-health-score-incomplete">
                      {t.service.healthIncomplete}
                    </span>
                  ) : null}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-blue-300">
                  {s.explainScore}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </span>
              </Link>
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block font-bold text-zinc-100">{t.service.providers}</span>
                <span className="block text-xs text-zinc-500">
                  {services
                    ? t.service.providersLine(services.providers.length - notNormal.length, services.providers.length)
                    : t.service.unread}
                </span>
              </span>
              <AdminStatusChip tone={providersTone} />
            </li>
            {notNormal.slice(0, 3).map((provider) => (
              <li key={provider.provider} className="flex items-center justify-between gap-3 py-2.5">
                <Link
                  href={`/admin/providers/${provider.provider}`}
                  className="flex min-w-0 items-center gap-2 font-medium text-zinc-200 hover:text-white"
                >
                  <AdminProviderMark provider={provider.provider} size={20} />
                  <span className="truncate">{provider.displayName}</span>
                </Link>
                <AdminStatusChip tone={providerTone(provider.status)}>{t.service.status[provider.status]}</AdminStatusChip>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <Link href="/admin/overview?tab=health#admin-health-environment" className="block font-bold text-zinc-100 hover:underline">
                  {t.service.deploy}
                </Link>
                <span className="block text-xs text-zinc-500">
                  {blockingEnvCount === 0 ? t.service.deployOk : t.service.deployBlocking(blockingEnvCount)}
                </span>
              </span>
              <AdminStatusChip tone={blockingEnvCount === 0 ? "ok" : "warn"} />
            </li>
            <li className="flex items-center justify-between gap-3 py-2.5 last:pb-0">
              <span className="min-w-0">
                <Link href="/admin/alerts" className="block font-bold text-zinc-100 hover:underline">
                  {t.service.alerts}
                </Link>
                <span className="block text-xs text-zinc-500">
                  {alertFailureCount === null
                    ? s.unreadable
                    : alertFailureCount === 0
                      ? t.service.alertsOk
                      : t.service.alertsFailed(alertFailureCount)}
                </span>
              </span>
              <AdminStatusChip tone={alertFailureCount === null ? "unknown" : alertFailureCount === 0 ? "ok" : "warn"} />
            </li>
          </ul>
        </AdminTile>
      </div>

      <AdminTile
        title={t.now.title}
        description={t.now.description}
        action={
          <Link href="/admin/work-queue" className="inline-flex items-center gap-1 text-sm font-bold text-blue-300 hover:text-blue-200">
            {t.now.seeAll}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        }
      >
        {topItems.length === 0 ? (
          <AdminStateBlock
            kind={inbox.queueUnread || inboxUnknown ? "error" : "empty"}
            title={inbox.queueUnread || inboxUnknown ? home.decisions.queueUnread : t.now.empty}
          />
        ) : (
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {topItems.map((item) => {
              const hours = inbox.waitHours[item.id];
              return (
                <li key={item.id} className="flex min-w-0 items-center gap-3 border-t border-zinc-800 py-3">
                  <AdminDecisionAvatar item={item} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-zinc-100">{decisionTitle(item, home)}</p>
                    <p className="truncate text-xs text-zinc-500">{decisionSubtitle(item, home)}</p>
                  </div>
                  {item.counted ? null : (
                    <AdminStatusChip tone={decisionWaitTone(hours)} className="hidden sm:inline-flex">
                      {decisionAge(hours, home)}
                    </AdminStatusChip>
                  )}
                  <Link
                    href={item.href}
                    className="inline-flex min-h-9 shrink-0 items-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
                  >
                    {t.now.open}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </AdminTile>

      <AdminTile
        title={s.latestChangesTitle}
        description={s.latestChangesDescription(recentActivityLimit)}
        action={
          <Link href="/admin/audit" className="text-sm font-bold text-blue-300 hover:text-blue-200">
            {s.openAuditLog}
          </Link>
        }
      >
        {recentActivity.length === 0 ? (
          <p className="text-sm text-zinc-500">{s.noActivity}</p>
        ) : (
          <ul className="flex flex-col">
            {recentActivity.map((entry) => (
              <li
                key={entry.id}
                className="grid gap-1 border-t border-zinc-800 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-zinc-100">{entry.summary}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {entry.actorEmail || s.fallbackActor} · {entry.action}
                  </p>
                </div>
                <span className="text-xs text-zinc-500">{formatAestDateTime(entry.createdAt) ?? "-"}</span>
              </li>
            ))}
          </ul>
        )}
      </AdminTile>
    </div>
  );
}
