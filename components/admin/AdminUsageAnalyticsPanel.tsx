import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Clock,
  Globe2,
  Layers,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminUsageAnalyticsMessages } from "@/lib/adminMessages/usageAnalytics";
import type {
  PeriodMetric,
  UsageAnalyticsReport,
  UsageSegmentDimension,
  UsageSegments,
} from "@/lib/adminUsageAnalytics";
import {
  OTHER_SEGMENT,
  UNKNOWN_SEGMENT,
  USAGE_PERIOD_IDS,
  matrixDayTotals,
  peakIndex,
  percentChange,
  safeRatio,
  type ShareTable,
} from "@/lib/adminUsageAnalyticsCore";

type Messages = AdminMessageShape<typeof adminUsageAnalyticsMessages.en>;

type Formatters = {
  count: (value: number) => string;
  percent: (ratio: number) => string;
  usd: (microUsd: number) => string;
  decimal: (value: number) => string;
  signedPercent: (value: number) => string;
  dateTime: (iso: string) => string;
  day: (key: string) => string;
  languageName: (code: string) => string | undefined;
  regionName: (code: string) => string | undefined;
};

const makeFormatters = (intlLocale: string, timeZone: string): Formatters => {
  const count = new Intl.NumberFormat(intlLocale);
  const percent = new Intl.NumberFormat(intlLocale, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const usd = new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  // A single short answer costs a fraction of a cent; two decimals would show
  // real spend as $0.00, which reads as free.
  const smallUsd = new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const decimal = new Intl.NumberFormat(intlLocale, {
    maximumFractionDigits: 1,
  });
  const signed = new Intl.NumberFormat(intlLocale, {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  });
  const dateTime = new Intl.DateTimeFormat(intlLocale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  // Day keys are already local calendar dates; format them as UTC so the
  // formatter does not shift them a second time.
  const day = new Intl.DateTimeFormat(intlLocale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    weekday: "short",
  });
  const displayName = (type: "language" | "region") => {
    try {
      const names = new Intl.DisplayNames([intlLocale], { type });
      return (code: string) => {
        try {
          const name = names.of(code);
          return name && name !== code ? name : undefined;
        } catch {
          return undefined;
        }
      };
    } catch {
      return () => undefined;
    }
  };
  return {
    count: (value) => count.format(value),
    percent: (ratio) => percent.format(ratio),
    usd: (microUsd) => {
      const dollars = microUsd / 1_000_000;
      if (dollars > 0 && dollars < 0.0001)
        return `< ${smallUsd.format(0.0001)}`;
      return (dollars > 0 && dollars < 1 ? smallUsd : usd).format(dollars);
    },
    decimal: (value) => decimal.format(value),
    signedPercent: (value) => `${signed.format(value)}%`,
    dateTime: (iso) => dateTime.format(new Date(iso)),
    day: (key) => day.format(new Date(`${key}T00:00:00.000Z`)),
    languageName: displayName("language"),
    regionName: displayName("region"),
  };
};

function Section({
  icon,
  title,
  description,
  children,
  testId,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="min-w-0 rounded-3xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6"
    >
      <div className="flex items-center gap-2 text-blue-300">
        {icon}
        <h3 className="text-lg font-bold text-white">{title}</h3>
      </div>
      {description ? (
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {description}
        </p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function DeltaLine({
  metric,
  m,
  f,
}: {
  metric: PeriodMetric;
  m: Messages;
  f: Formatters;
}) {
  const change = percentChange(metric.current, metric.previous);
  if (change === null) {
    return (
      <p className="mt-1 text-xs leading-5 text-zinc-500">{m.noPrevious}</p>
    );
  }
  if (Math.abs(change) < 0.05) {
    return (
      <p className="mt-1 text-xs leading-5 text-zinc-500">{m.unchanged}</p>
    );
  }
  return (
    <p
      className={`mt-1 text-xs font-semibold leading-5 ${change > 0 ? "text-blue-300" : "text-amber-300"}`}
    >
      {m.vsPrevious(f.signedPercent(change))}
    </p>
  );
}

function Kpi({
  label,
  value,
  detail,
  metric,
  m,
  f,
}: {
  label: string;
  value: string;
  detail: string;
  metric?: PeriodMetric;
  m: Messages;
  f: Formatters;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black text-white tabular-nums">
        {value}
      </p>
      {metric ? <DeltaLine metric={metric} m={m} f={f} /> : null}
      <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>
    </div>
  );
}

function ShareList({
  table,
  labelFor,
  m,
  f,
}: {
  table: ShareTable;
  labelFor: (key: string) => string;
  m: Messages;
  f: Formatters;
}) {
  if (!table.rows.length) {
    return <p className="text-sm text-zinc-500">{m.emptyDistribution}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {table.rows.map((row) => {
        const label =
          row.key === UNKNOWN_SEGMENT
            ? m.unknown
            : row.key === OTHER_SEGMENT
              ? m.other
              : labelFor(row.key);
        return (
          <li
            key={row.key}
            aria-label={m.shareRowLabel(
              label,
              f.count(row.count),
              f.percent(row.share),
            )}
          >
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-zinc-200" title={label}>
                {label}
              </span>
              <span className="shrink-0 tabular-nums text-zinc-400">
                {f.count(row.count)} · {f.percent(row.share)}
              </span>
            </div>
            <div
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800"
              aria-hidden="true"
            >
              <div
                className={`h-full rounded-full ${row.key === UNKNOWN_SEGMENT ? "bg-zinc-500" : "bg-blue-500"}`}
                style={{
                  width: `${Math.max(row.share * 100, row.count > 0 ? 1 : 0)}%`,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PeriodSelector({
  report,
  m,
}: {
  report: UsageAnalyticsReport;
  m: Messages;
}) {
  return (
    <nav aria-label={m.periodsLabel} className="flex flex-wrap gap-2">
      {USAGE_PERIOD_IDS.map((id) => {
        const active = report.window.id === id;
        return (
          <Link
            key={id}
            href={`/admin/analytics?tab=usage&period=${id}`}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
              active
                ? "border-blue-500/50 bg-blue-500/15 text-blue-100"
                : "border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700 hover:text-white"
            }`}
          >
            {m.periods[id]}
          </Link>
        );
      })}
    </nav>
  );
}

function TrendChart({
  report,
  m,
  f,
}: {
  report: UsageAnalyticsReport;
  m: Messages;
  f: Formatters;
}) {
  const days = report.trend.days;
  const max = Math.max(1, ...days.map((day) => day.accounts + day.guests));
  const width = 600;
  const height = 160;
  const slot = days.length ? width / days.length : width;
  const barWidth = Math.max(2, slot * 0.7);
  return (
    <figure className="min-w-0">
      <svg
        role="img"
        aria-label={m.trendChartLabel}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
      >
        {days.map((day, index) => {
          const accountsHeight = (day.accounts / max) * (height - 4);
          const guestsHeight = (day.guests / max) * (height - 4);
          const x = index * slot + (slot - barWidth) / 2;
          return (
            <g key={day.day}>
              <title>
                {m.trendDayTitle(
                  f.day(day.day),
                  f.count(day.accounts),
                  f.count(day.guests),
                  f.count(day.messages),
                )}
              </title>
              <rect
                x={x}
                y={height - accountsHeight}
                width={barWidth}
                height={accountsHeight}
                className="fill-blue-500"
              />
              <rect
                x={x}
                y={height - accountsHeight - guestsHeight}
                width={barWidth}
                height={guestsHeight}
                className="fill-zinc-500"
              />
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        <span>{days[0] ? f.day(days[0].day) : ""}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-sm bg-blue-500"
            />
            {m.legendAccounts}
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-sm bg-zinc-500"
            />
            {m.legendGuests}
          </span>
        </span>
        <span>{days.length ? f.day(days[days.length - 1].day) : ""}</span>
      </figcaption>
      {/* The bars' <title>s are not reachable by a screen reader; the same
          numbers are here as a table. The table sits inside an sr-only div
          rather than carrying the class itself: width and overflow do not
          shrink a table box, so an sr-only table keeps its full invisible
          width and pushes the whole page into horizontal scroll on a phone. */}
      <div className="sr-only">
        <table>
          <caption>{m.trendTableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{m.trendColumns.day}</th>
              <th scope="col">{m.trendColumns.accounts}</th>
              <th scope="col">{m.trendColumns.guests}</th>
              <th scope="col">{m.trendColumns.messages}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{f.day(day.day)}</th>
                <td>{f.count(day.accounts)}</td>
                <td>{f.count(day.guests)}</td>
                <td>{f.count(day.messages)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function ActivityHeatmap({
  report,
  m,
  f,
}: {
  report: UsageAnalyticsReport;
  m: Messages;
  f: Formatters;
}) {
  const { matrix, hours } = report.activity;
  const max = Math.max(0, ...matrix.flat());
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  const peakHour = peakIndex(hours);
  const dayTotals = matrixDayTotals(matrix);
  const peakDay = peakIndex(dayTotals);
  if (max === 0) {
    return <p className="text-sm text-zinc-500">{m.noActivity}</p>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-300">
        {peakHour !== null ? (
          <span>
            {m.peakHour(hourLabel(peakHour), f.count(hours[peakHour]))}
          </span>
        ) : null}
        {peakDay !== null ? (
          <span>
            {m.peakDay(m.weekdays[peakDay], f.count(dayTotals[peakDay]))}
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table
          className="border-separate border-spacing-0.5 text-[11px] text-zinc-500"
          aria-label={m.activityTableLabel}
        >
          <thead>
            <tr>
              <th scope="col" className="w-8" />
              {hours.map((_, hour) => (
                <th
                  key={hour}
                  scope="col"
                  className="w-5 text-center font-normal tabular-nums"
                >
                  {hour % 3 === 0 ? (
                    String(hour).padStart(2, "0")
                  ) : (
                    <span className="sr-only">{hourLabel(hour)}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, dayIndex) => (
              <tr key={dayIndex}>
                <th
                  scope="row"
                  className="pr-1 text-left font-semibold text-zinc-400"
                >
                  {m.weekdays[dayIndex]}
                </th>
                {row.map((value, hour) => {
                  const label = m.hourCell(
                    m.weekdays[dayIndex],
                    hourLabel(hour),
                    f.count(value),
                  );
                  return (
                    <td
                      key={hour}
                      title={label}
                      className="h-5 w-5 rounded-sm bg-zinc-800 p-0"
                    >
                      <span
                        aria-hidden="true"
                        className="block h-5 w-5 rounded-sm bg-blue-500"
                        style={{
                          opacity: value ? 0.15 + 0.85 * (value / max) : 0,
                        }}
                      />
                      <span className="sr-only">{label}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SEGMENT_ORDER: UsageSegmentDimension[] = [
  "plan",
  "language",
  "defaultModel",
  "country",
  "region",
  "timeZone",
];

function SegmentComparison({
  active,
  all,
  labelFor,
  m,
  f,
}: {
  active: UsageSegments;
  all: UsageSegments;
  labelFor: (dimension: UsageSegmentDimension, key: string) => string;
  m: Messages;
  f: Formatters;
}) {
  return (
    <div className="flex flex-col gap-4">
      {SEGMENT_ORDER.map((dimension) => (
        <div
          key={dimension}
          className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4"
        >
          <h4 className="text-sm font-bold text-white">
            {m.dimensions[dimension]}
          </h4>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-blue-300">
                {m.activePopulation(f.count(active.plan.total))}
              </p>
              <ShareList
                table={active[dimension]}
                labelFor={(key) => labelFor(dimension, key)}
                m={m}
                f={f}
              />
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
                {m.allPopulation(f.count(all.plan.total))}
              </p>
              <ShareList
                table={all[dimension]}
                labelFor={(key) => labelFor(dimension, key)}
                m={m}
                f={f}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The usage tab: who used Tomverse in a Brisbane calendar period, what they
 * used, when, and where they are. Server-rendered from one report; the only
 * interaction is choosing the period, which is a link.
 */
export async function AdminUsageAnalyticsPanel({
  report,
}: {
  report: UsageAnalyticsReport;
}) {
  const m = await getAdminMessages(adminUsageAnalyticsMessages);
  const f = makeFormatters(m.intlLocale, report.timeZone);
  const h = report.headline;

  const range = `${f.dateTime(report.window.start)} – ${f.dateTime(report.window.end)}`;
  const previousRange = `${f.dateTime(report.window.previousStart)} – ${f.dateTime(report.window.previousEnd)}`;
  const failureRatio = safeRatio(
    h.failedRequests.current,
    h.finishedRequests.current,
  );
  const messagesPerAccount = safeRatio(
    h.userMessages.current,
    h.activeAccounts.current,
  );
  const costPerUser = safeRatio(
    h.providerCostMicroUsd.current - h.imageCostMicroUsd.current,
    h.activeAccounts.current + h.activeGuests.current,
  );
  const na = m.notAvailable;

  const languageLabel = (code: string) => {
    const name = f.languageName(code);
    return name ? `${name} (${code})` : code;
  };
  const countryLabel = (code: string) => {
    const name = /^[A-Z]{2}$/.test(code) ? f.regionName(code) : undefined;
    return name ? `${name} (${code})` : code;
  };
  const segmentLabel = (dimension: UsageSegmentDimension, key: string) =>
    dimension === "language"
      ? languageLabel(key)
      : dimension === "country"
        ? countryLabel(key)
        : key;

  const retention = report.retention;
  const ratioText = (value: number, denominator: number) => {
    const ratio = safeRatio(value, denominator);
    return ratio === null ? na : f.percent(ratio);
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-5"
      data-testid="admin-usage-analytics"
    >
      <section className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
        <div className="flex items-center gap-2 text-blue-300">
          <Users className="h-5 w-5" aria-hidden="true" />
          <span className="text-xs font-bold uppercase tracking-[0.18em]">
            {m.eyebrow}
          </span>
        </div>
        <h2 className="mt-3 text-2xl font-black text-white">{m.title}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.description}
        </p>

        <div className="mt-5">
          <PeriodSelector report={report} m={m} />
        </div>

        <div className="mt-4 flex flex-col gap-1 text-sm text-zinc-400">
          <p className="font-semibold text-zinc-200">
            {m.windowSummary(range, report.timeZone)}
          </p>
          <p>{m.comparedWith(previousRange)}</p>
          {report.window.inProgress ? <p>{m.inProgress}</p> : null}
          <p className="text-xs text-zinc-500">
            {m.generatedAt(f.dateTime(report.generatedAt))}
          </p>
        </div>

        {!report.available ? (
          <p
            role="status"
            className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            {m.unavailable}
          </p>
        ) : null}

        {report.available ? (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi
                label={m.kpi.activeAccounts}
                value={f.count(h.activeAccounts.current)}
                metric={h.activeAccounts}
                detail={m.kpi.activeAccountsDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.activeGuests}
                value={f.count(h.activeGuests.current)}
                metric={h.activeGuests}
                detail={m.kpi.activeGuestsDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.userMessages}
                value={f.count(h.userMessages.current)}
                metric={h.userMessages}
                detail={m.kpi.userMessagesDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.modelRequests}
                value={f.count(h.modelRequests.current)}
                metric={h.modelRequests}
                detail={m.kpi.modelRequestsDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.newSignups}
                value={f.count(h.newSignups.current)}
                metric={h.newSignups}
                detail={m.kpi.newSignupsDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.conversationsStarted}
                value={f.count(h.conversationsStarted.current)}
                metric={h.conversationsStarted}
                detail={m.kpi.conversationsStartedDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.creditsUsed}
                value={f.count(h.creditsUsed.current)}
                metric={h.creditsUsed}
                detail={m.kpi.creditsUsedDetail}
                m={m}
                f={f}
              />
              <Kpi
                label={m.kpi.providerCost}
                value={f.usd(h.providerCostMicroUsd.current)}
                metric={h.providerCostMicroUsd}
                detail={`${m.kpi.providerCostDetail}. ${m.secondary.imageCost(f.usd(h.imageCostMicroUsd.current))}`}
                m={m}
                f={f}
              />
            </div>

            <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                {
                  label: m.secondary.activeConversations,
                  value: f.count(h.activeConversations.current),
                  detail: "",
                },
                {
                  label: m.secondary.messagesPerAccount,
                  value:
                    messagesPerAccount === null
                      ? na
                      : f.decimal(messagesPerAccount),
                  detail: "",
                },
                {
                  label: m.secondary.failureRate,
                  value: failureRatio === null ? na : f.percent(failureRatio),
                  detail: m.secondary.failureDetail(
                    f.count(h.failedRequests.current),
                    f.count(h.finishedRequests.current),
                  ),
                },
                {
                  label: m.secondary.costPerAccount,
                  value: costPerUser === null ? na : f.usd(costPerUser),
                  detail: m.secondary.costPerAccountDetail,
                },
                {
                  label: m.secondary.aiReviewRuns,
                  value: f.count(h.aiReviewRuns.current),
                  detail: "",
                },
                {
                  label: m.secondary.imagesGenerated,
                  value: f.count(h.imagesGenerated.current),
                  detail: "",
                },
                {
                  label: m.secondary.newActive,
                  value: f.count(report.engagement.newActiveAccounts),
                  detail: m.secondary.newActiveDetail(
                    f.count(report.engagement.newActiveAccounts),
                  ),
                },
                {
                  label: m.secondary.operators,
                  value: f.count(report.engagement.operatorActiveAccounts),
                  detail: m.secondary.operatorsDetail,
                },
                {
                  label: m.secondary.concentration,
                  value:
                    report.engagement.topTenRequestShare === null
                      ? na
                      : f.percent(report.engagement.topTenRequestShare),
                  detail: m.secondary.concentrationDetail,
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3"
                >
                  <dt className="text-xs font-semibold text-zinc-500">
                    {item.label}
                  </dt>
                  <dd className="mt-1 text-lg font-bold text-white tabular-nums">
                    {item.value}
                  </dd>
                  {item.detail ? (
                    <dd className="text-xs leading-5 text-zinc-500">
                      {item.detail}
                    </dd>
                  ) : null}
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </section>

      {/* A failed read shows the selector and the notice only. Zeros under a
          banner read as "nobody used Tomverse" to anyone who skims past it. */}
      {report.available ? (
        <>
          <Section
            icon={<Activity className="h-5 w-5" aria-hidden="true" />}
            title={m.trendTitle}
            description={m.trendDescription}
            testId="admin-usage-trend"
          >
            <TrendChart report={report} m={m} f={f} />
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Kpi
                label={m.wau}
                value={f.count(report.trend.wau)}
                detail=""
                m={m}
                f={f}
              />
              <Kpi
                label={m.mau}
                value={f.count(report.trend.mau)}
                detail=""
                m={m}
                f={f}
              />
              <Kpi
                label={m.stickiness}
                value={
                  report.trend.stickiness === null
                    ? na
                    : f.percent(report.trend.stickiness)
                }
                detail={m.stickinessDetail}
                m={m}
                f={f}
              />
            </div>
            <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
              <h4 className="text-sm font-bold text-white">
                {m.retentionTitle}
              </h4>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {m.retentionDescription(
                  f.dateTime(retention.cohortStart),
                  f.dateTime(retention.cohortEnd),
                )}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Kpi
                  label={m.cohort}
                  value={f.count(retention.cohort)}
                  detail=""
                  m={m}
                  f={f}
                />
                <Kpi
                  label={m.activated}
                  value={ratioText(retention.activatedDay0, retention.cohort)}
                  detail={m.ofCohort(f.count(retention.activatedDay0))}
                  m={m}
                  f={f}
                />
                <Kpi
                  label={m.retained}
                  value={ratioText(
                    retention.retainedWeek1,
                    retention.activatedDay0,
                  )}
                  detail={m.ofActivated(f.count(retention.retainedWeek1))}
                  m={m}
                  f={f}
                />
              </div>
            </div>
          </Section>

          <Section
            icon={<Layers className="h-5 w-5" aria-hidden="true" />}
            title={m.modelsTitle}
            description={m.modelsDescription}
            testId="admin-usage-models"
          >
            {report.models.rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-[0.12em] text-zinc-500">
                    <tr>
                      <th scope="col" className="py-2 pr-3">
                        {m.modelColumns.model}
                      </th>
                      <th scope="col" className="py-2 pr-3">
                        {m.modelColumns.provider}
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right">
                        {m.modelColumns.requests}
                      </th>
                      <th scope="col" className="py-2 pr-3">
                        {m.modelColumns.share}
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right">
                        {m.modelColumns.failure}
                      </th>
                      <th scope="col" className="py-2 pr-3 text-right">
                        {m.modelColumns.credits}
                      </th>
                      <th scope="col" className="py-2 text-right">
                        {m.modelColumns.cost}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {report.models.rows.map((row) => {
                      const failure = safeRatio(row.failed, row.finished);
                      return (
                        <tr key={`${row.provider}:${row.modelId}`}>
                          <td className="py-2 pr-3 font-mono text-xs text-zinc-100">
                            {row.modelId}
                          </td>
                          <td className="py-2 pr-3 text-zinc-400">
                            {row.provider}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-zinc-200">
                            {f.count(row.requests)}
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <div
                                className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800"
                                aria-hidden="true"
                              >
                                <div
                                  className="h-full rounded-full bg-blue-500"
                                  style={{ width: `${row.share * 100}%` }}
                                />
                              </div>
                              <span className="tabular-nums text-zinc-300">
                                {f.percent(row.share)}
                              </span>
                            </div>
                          </td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${failure && failure >= 0.05 ? "text-amber-300" : "text-zinc-400"}`}
                          >
                            {failure === null ? na : f.percent(failure)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">
                            {f.count(row.credits)}
                          </td>
                          <td className="py-2 text-right tabular-nums text-zinc-400">
                            {f.usd(row.costMicroUsd)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-zinc-500">
                  {m.modelsTruncated(report.models.rows.length)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">{m.modelsEmpty}</p>
            )}
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-bold text-white">
                  {m.providersTitle}
                </h4>
                <ShareList
                  table={report.providers}
                  labelFor={(key) => key}
                  m={m}
                  f={f}
                />
              </div>
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-bold text-white">
                  {m.sourcesTitle}
                </h4>
                <ShareList
                  table={report.requestsBySource}
                  labelFor={(key) => key}
                  m={m}
                  f={f}
                />
              </div>
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-bold text-white">
                  {m.productsTitle}
                </h4>
                <ShareList
                  table={report.conversationsByProduct}
                  labelFor={(key) => key}
                  m={m}
                  f={f}
                />
              </div>
            </div>
          </Section>

          <Section
            icon={<Clock className="h-5 w-5" aria-hidden="true" />}
            title={m.activityTitle}
            description={m.activityDescription(report.timeZone)}
            testId="admin-usage-activity"
          >
            <ActivityHeatmap report={report} m={m} f={f} />
          </Section>

          <Section
            icon={<Globe2 className="h-5 w-5" aria-hidden="true" />}
            title={m.segmentsTitle}
            description={m.segmentsDescription}
            testId="admin-usage-segments"
          >
            <SegmentComparison
              active={report.activeSegments}
              all={report.allAccountSegments}
              labelFor={segmentLabel}
              m={m}
              f={f}
            />
            <p className="mt-3 text-xs leading-5 text-zinc-500">
              {m.countryNote}
            </p>
            <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
              <h4 className="text-sm font-bold text-white">
                {m.visitorsTitle}
              </h4>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {m.visitorsDescription}
              </p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div className="min-w-0">
                  <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
                    {m.visitorCountry}
                  </p>
                  <ShareList
                    table={report.visitors.country}
                    labelFor={countryLabel}
                    m={m}
                    f={f}
                  />
                </div>
                <div className="min-w-0">
                  <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-zinc-400">
                    {m.visitorLanguage}
                  </p>
                  <ShareList
                    table={report.visitors.language}
                    labelFor={languageLabel}
                    m={m}
                    f={f}
                  />
                </div>
              </div>
            </div>
          </Section>
        </>
      ) : null}
    </div>
  );
}
