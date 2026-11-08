import type { ReactNode } from "react";
import { AdminProviderMark } from "@/components/admin/ui/AdminProviderMark";
import { AdminDonut } from "@/components/admin/ui/AdminCharts";
import { AdminHeatmap } from "@/components/admin/ui/AdminHeatmap";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminLineChart } from "@/components/admin/ui/AdminLineChart";
import { AdminSegmentedLinks } from "@/components/admin/ui/AdminSegmentedLinks";
import { AdminShareList } from "@/components/admin/ui/AdminShareList";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { adminUsageAnalyticsMessages } from "@/lib/adminMessages/usageAnalytics";
import { trendWindows } from "@/lib/adminLineChartCore";
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
import type { AdminChartColor } from "@/lib/adminUiCore";

type Messages = AdminMessageShape<typeof adminUsageAnalyticsMessages.en>;

type Formatters = {
  count: (value: number) => string;
  percent: (ratio: number) => string;
  usd: (microUsd: number) => string;
  decimal: (value: number) => string;
  dateTime: (iso: string) => string;
  shortDay: (key: string) => string;
  languageName: (code: string) => string | undefined;
  regionName: (code: string) => string | undefined;
};

const makeFormatters = (intlLocale: string, timeZone: string): Formatters => {
  const count = new Intl.NumberFormat(intlLocale);
  const percent = new Intl.NumberFormat(intlLocale, { style: "percent", maximumFractionDigits: 1 });
  const usd = new Intl.NumberFormat(intlLocale, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  // A single short answer costs a fraction of a cent; two decimals would show
  // real spend as $0.00, which reads as free.
  const smallUsd = new Intl.NumberFormat(intlLocale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const decimal = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 });
  const dateTime = new Intl.DateTimeFormat(intlLocale, { timeZone, dateStyle: "medium", timeStyle: "short" });
  // Day keys are local calendar dates read as midnight in the instant's own
  // zone; Brisbane has no daylight saving, so the date does not shift again.
  const shortDay = new Intl.DateTimeFormat(intlLocale, {
    timeZone: "Australia/Brisbane",
    month: "short",
    day: "numeric",
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
      if (dollars > 0 && dollars < 0.0001) return `< ${smallUsd.format(0.0001)}`;
      return (dollars > 0 && dollars < 1 ? smallUsd : usd).format(dollars);
    },
    decimal: (value) => decimal.format(value),
    dateTime: (iso) => dateTime.format(new Date(iso)),
    shortDay: (key) => shortDay.format(new Date(`${key}T00:00:00.000Z`)),
    languageName: displayName("language"),
    regionName: displayName("region"),
  };
};

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  moonshot: "Moonshot",
  minimax: "MiniMax",
  qwen: "Qwen",
  zhipu: "Zhipu",
  perplexity: "Perplexity",
};

const DONUT_COLORS: AdminChartColor[] = ["blue", "amber", "emerald", "violet", "pink", "cyan", "zinc"];

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
          row.key === UNKNOWN_SEGMENT ? m.unknown : row.key === OTHER_SEGMENT ? m.other : labelFor(row.key);
        return (
          <li key={row.key} aria-label={m.shareRowLabel(label, f.count(row.count), f.percent(row.share))}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-zinc-200" title={label}>
                {label}
              </span>
              <span className="shrink-0 tabular-nums text-zinc-400">
                {f.count(row.count)} · {f.percent(row.share)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800" aria-hidden="true">
              <div
                className={`h-full rounded-full ${row.key === UNKNOWN_SEGMENT ? "bg-zinc-500" : "bg-blue-500"}`}
                style={{ width: `${Math.max(row.share * 100, row.count > 0 ? 1 : 0)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const SEGMENT_ORDER: UsageSegmentDimension[] = ["plan", "language", "defaultModel", "country", "region", "timeZone"];

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
        <div key={dimension} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
          <h4 className="text-sm font-bold text-white">{m.dimensions[dimension]}</h4>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-2 text-xs font-bold text-blue-300">{m.activePopulation(f.count(active.plan.total))}</p>
              <ShareList table={active[dimension]} labelFor={(key) => labelFor(dimension, key)} m={m} f={f} />
            </div>
            <div className="min-w-0">
              <p className="mb-2 text-xs font-bold text-zinc-400">{m.allPopulation(f.count(all.plan.total))}</p>
              <ShareList table={all[dimension]} labelFor={(key) => labelFor(dimension, key)} m={m} f={f} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MiniStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/40 px-4 py-3">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums text-white">{value}</p>
      {detail ? <p className="text-xs leading-5 text-zinc-500">{detail}</p> : null}
    </div>
  );
}

/**
 * The usage tab: who used Tomverse in a Brisbane calendar period, what they
 * used, when and where. Server-rendered from one report; the only interaction
 * is choosing the period, which is a link kept in the URL.
 *
 * A failed read shows the period picker and a failure notice only. Zeros under
 * a banner read as "nobody used Tomverse" to anyone who skims past it.
 *
 * What is drawn is what the report holds: the trend is the report's fixed
 * 30-day daily series, so the comparison line appears only where that series
 * is long enough to hold the period and the one before it.
 */
export async function AdminUsageAnalyticsPanel({ report }: { report: UsageAnalyticsReport }) {
  const [m, home] = await Promise.all([
    getAdminMessages(adminUsageAnalyticsMessages),
    getAdminMessages(adminHomeMessages),
  ]);
  const mt = home.metrics;
  const f = makeFormatters(m.intlLocale, report.timeZone);
  const h = report.headline;
  const na = m.notAvailable;

  const range = `${f.dateTime(report.window.start)} – ${f.dateTime(report.window.end)}`;
  const previousRange = `${f.dateTime(report.window.previousStart)} – ${f.dateTime(report.window.previousEnd)}`;

  const delta = (metric: PeriodMetric): ReactNode => {
    const change = percentChange(metric.current, metric.previous);
    if (change === null) return mt.deltaNone;
    if (Math.abs(change) < 0.05) return mt.deltaSame;
    const text = `${Math.abs(change).toFixed(change % 1 === 0 ? 0 : 1)}%`;
    return change > 0 ? (
      <span className="font-bold text-emerald-300">▲ {mt.deltaUp(text)}</span>
    ) : (
      <span className="font-bold text-amber-300">▼ {mt.deltaDown(text)}</span>
    );
  };

  const selector = (
    <AdminSegmentedLinks
      label={m.periodsLabel}
      items={USAGE_PERIOD_IDS.map((id) => ({
        id,
        label: m.periods[id],
        href: `/admin/analytics?tab=usage&period=${id}`,
        active: report.window.id === id,
      }))}
    />
  );

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 text-sm text-zinc-400">
        <h2 className="sr-only">{m.title}</h2>
        <p className="font-bold text-zinc-200">{m.windowSummary(range, report.timeZone)}</p>
        <p>{m.comparedWith(previousRange)}</p>
        {report.window.inProgress ? <p>{m.inProgress}</p> : null}
        <p className="text-xs text-zinc-500">{m.generatedAt(f.dateTime(report.generatedAt))}</p>
      </div>
      <div className="shrink-0">{selector}</div>
    </div>
  );

  if (!report.available) {
    return (
      <div className="flex min-w-0 flex-col gap-5" data-testid="admin-usage-analytics">
        {header}
        <AdminStateBlock kind="error" title={mt.unavailableTitle} detail={mt.unavailableDetail} />
      </div>
    );
  }

  const days = report.trend.days;
  const windowDays = ["today", "yesterday", "last7"].includes(report.window.id) ? 7 : 30;
  const accountSeries = days.map((day) => day.accounts);
  const { current, previous } = trendWindows(accountSeries, windowDays);
  const shown = days.slice(days.length - current.length);
  const labelIndexes = Array.from(new Set([0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(p * (shown.length - 1)))));
  const chartLabels = labelIndexes.map((index) =>
    index === shown.length - 1 ? m.periods.today : f.shortDay(shown[index].day)
  );

  const failureRatio = safeRatio(h.failedRequests.current, h.finishedRequests.current);
  const messagesPerAccount = safeRatio(h.userMessages.current, h.activeAccounts.current);

  const languageLabel = (code: string) => {
    const name = f.languageName(code);
    return name ? `${name} (${code})` : code;
  };
  const countryLabel = (code: string) => {
    const name = /^[A-Z]{2}$/.test(code) ? f.regionName(code) : undefined;
    return name ? `${name} (${code})` : code;
  };
  const segmentLabel = (dimension: UsageSegmentDimension, key: string) =>
    dimension === "language" ? languageLabel(key) : dimension === "country" ? countryLabel(key) : key;

  const providerRows = report.providers.rows;
  const providerLabel = (key: string) =>
    key === UNKNOWN_SEGMENT ? mt.modelShare.unknown : key === OTHER_SEGMENT ? mt.modelShare.other : (PROVIDER_NAMES[key] ?? key);
  const donutSegments = providerRows.map((row, index) => ({
    value: row.count,
    color: DONUT_COLORS[index % DONUT_COLORS.length],
    label: providerLabel(row.key),
  }));

  const { matrix, hours } = report.activity;
  const peakHour = peakIndex(hours);
  const dayTotals = matrixDayTotals(matrix);
  const peakDay = peakIndex(dayTotals);
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

  const countryRows = report.activeSegments.country.rows.filter((row) => row.key !== UNKNOWN_SEGMENT).slice(0, 6);
  const retention = report.retention;
  const ratioText = (value: number, denominator: number) => {
    const ratio = safeRatio(value, denominator);
    return ratio === null ? na : f.percent(ratio);
  };

  const footer = [
    { label: mt.footer.activeConversations, value: f.count(h.activeConversations.current) },
    { label: mt.footer.messagesPerAccount, value: messagesPerAccount === null ? na : f.decimal(messagesPerAccount) },
    { label: mt.footer.failureRate, value: failureRatio === null ? na : f.percent(failureRatio) },
    { label: mt.footer.credits, value: f.count(h.creditsUsed.current) },
    { label: mt.footer.providerCost, value: f.usd(h.providerCostMicroUsd.current) },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="admin-usage-analytics">
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={m.kpi.activeAccounts}
          value={f.count(h.activeAccounts.current)}
          detail={delta(h.activeAccounts)}
          trend={accountSeries}
        />
        <AdminKpiCard
          label={m.kpi.userMessages}
          value={f.count(h.userMessages.current)}
          detail={delta(h.userMessages)}
          trend={days.map((day) => day.messages)}
        />
        <AdminKpiCard
          label={m.kpi.modelRequests}
          value={f.count(h.modelRequests.current)}
          detail={delta(h.modelRequests)}
          trend={days.map((day) => day.requests)}
        />
        <AdminKpiCard label={m.kpi.newSignups} value={f.count(h.newSignups.current)} detail={delta(h.newSignups)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <AdminTile
          title={mt.dailyActive.title}
          description={previous ? mt.dailyActive.description(current.length) : mt.dailyActive.descriptionSingle(current.length)}
          action={
            previous ? (
              <span className="hidden items-center gap-3 text-xs text-zinc-400 sm:flex">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-0.5 w-4 rounded bg-blue-500" />
                  {mt.dailyActive.current(current.length)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-0.5 w-4 border-t-2 border-dashed border-zinc-500" />
                  {mt.dailyActive.previous(current.length)}
                </span>
              </span>
            ) : null
          }
          data-testid="admin-usage-trend"
        >
          <AdminLineChart
            values={current}
            previous={previous}
            labels={chartLabels}
            label={mt.dailyActive.label(current.length)}
          />
          {/* The same numbers as a table: a chart's points are not reachable by a screen reader. */}
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
                    <th scope="row">{f.shortDay(day.day)}</th>
                    <td>{f.count(day.accounts)}</td>
                    <td>{f.count(day.guests)}</td>
                    <td>{f.count(day.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminTile>

        <AdminTile title={mt.modelShare.title} description={mt.modelShare.description} data-testid="admin-usage-model-share">
          {providerRows.length === 0 ? (
            <p className="text-sm text-zinc-500">{mt.modelShare.empty}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-6">
              <AdminDonut segments={donutSegments} size={132} stroke={16} label={mt.modelShare.title}>
                <span className="text-xl font-black tabular-nums text-white">{f.count(report.providers.total)}</span>
                <span className="text-xs text-zinc-400">{mt.modelShare.center}</span>
              </AdminDonut>
              <ul className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                {providerRows.map((row) => (
                  <li key={row.key} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-zinc-300">
                      {PROVIDER_NAMES[row.key] ? <AdminProviderMark provider={row.key} size={18} /> : null}
                      <span className="truncate">{providerLabel(row.key)}</span>
                    </span>
                    <span className="font-bold tabular-nums text-zinc-100">{f.percent(row.share)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </AdminTile>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <AdminTile
          title={mt.when.title}
          description={`${mt.when.description(report.timeZone)}${
            peakHour !== null && peakDay !== null
              ? ` ${mt.when.peak(m.weekdays[peakDay], hourLabel(peakHour))}`
              : ""
          }`}
          data-testid="admin-usage-activity"
        >
          {matrix.flat().every((value) => value === 0) ? (
            <p className="text-sm text-zinc-500">{m.noActivity}</p>
          ) : (
            <AdminHeatmap
              matrix={matrix}
              rowLabels={m.weekdays}
              cellLabel={(row, column, value) => m.hourCell(m.weekdays[row], hourLabel(column), f.count(value))}
              label={m.activityTableLabel}
            />
          )}
        </AdminTile>

        <AdminTile title={mt.where.title} description={mt.where.description}>
          {countryRows.length === 0 ? (
            <p className="text-sm text-zinc-500">{mt.where.empty}</p>
          ) : (
            <AdminShareList
              rows={countryRows.map((row) => ({
                key: row.key,
                label: countryLabel(row.key).replace(/ \([A-Z]{2}\)$/, ""),
                lead: (
                  <span className="inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-800 text-[10px] font-bold text-zinc-400">
                    {/^[A-Z]{2}$/.test(row.key) ? row.key : "--"}
                  </span>
                ),
                value: row.share,
                valueLabel: f.percent(row.share),
              }))}
            />
          )}
        </AdminTile>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 sm:grid-cols-3 xl:grid-cols-5">
        {footer.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-xs text-zinc-500">{item.label}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums text-white">{item.value}</dd>
          </div>
        ))}
      </dl>

      <details className="group rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <summary className="cursor-pointer list-none text-sm font-bold text-zinc-100 [&::-webkit-details-marker]:hidden">
          {mt.more.summary}
          <span className="ml-2 text-xs font-normal text-zinc-500">{mt.more.description}</span>
        </summary>
        <div className="mt-5 flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <MiniStat label={m.wau} value={f.count(report.trend.wau)} />
            <MiniStat label={m.mau} value={f.count(report.trend.mau)} />
            <MiniStat
              label={m.stickiness}
              value={report.trend.stickiness === null ? na : f.percent(report.trend.stickiness)}
              detail={m.stickinessDetail}
            />
          </div>

          <div>
            <h3 className="text-sm font-bold text-white">{m.retentionTitle}</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              {m.retentionDescription(f.dateTime(retention.cohortStart), f.dateTime(retention.cohortEnd))}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <MiniStat label={m.cohort} value={f.count(retention.cohort)} />
              <MiniStat
                label={m.activated}
                value={ratioText(retention.activatedDay0, retention.cohort)}
                detail={m.ofCohort(f.count(retention.activatedDay0))}
              />
              <MiniStat
                label={m.retained}
                value={ratioText(retention.retainedWeek1, retention.activatedDay0)}
                detail={m.ofActivated(f.count(retention.retainedWeek1))}
              />
            </div>
          </div>

          <section data-testid="admin-usage-models">
            <h3 className="text-sm font-bold text-white">{m.modelsTitle}</h3>
            <p className="mb-3 mt-1 text-xs leading-5 text-zinc-500">{m.modelsDescription}</p>
            <AdminDataTable
              caption={m.modelsTitle}
              rows={report.models.rows}
              rowKey={(row) => `${row.provider}:${row.modelId}`}
              emptyState={<AdminStateBlock kind="empty" title={m.modelsEmpty} />}
              cardTitle={(row) => <span className="font-mono text-xs">{row.modelId}</span>}
              cardMeta={(row) => `${row.provider} · ${f.count(row.requests)} · ${f.percent(row.share)}`}
              footer={<span className="text-xs text-zinc-500">{m.modelsTruncated(report.models.rows.length)}</span>}
              columns={[
                {
                  key: "model",
                  header: m.modelColumns.model,
                  render: (row) => <span className="font-mono text-xs text-zinc-100">{row.modelId}</span>,
                },
                { key: "provider", header: m.modelColumns.provider, render: (row) => row.provider },
                {
                  key: "requests",
                  header: m.modelColumns.requests,
                  align: "right",
                  render: (row) => f.count(row.requests),
                },
                { key: "share", header: m.modelColumns.share, align: "right", render: (row) => f.percent(row.share) },
                {
                  key: "failure",
                  header: m.modelColumns.failure,
                  align: "right",
                  render: (row) => {
                    const failure = safeRatio(row.failed, row.finished);
                    return (
                      <span className={failure !== null && failure >= 0.05 ? "text-amber-300" : ""}>
                        {failure === null ? na : f.percent(failure)}
                      </span>
                    );
                  },
                },
                {
                  key: "credits",
                  header: m.modelColumns.credits,
                  align: "right",
                  render: (row) => f.count(row.credits),
                },
                {
                  key: "cost",
                  header: m.modelColumns.cost,
                  align: "right",
                  render: (row) => f.usd(row.costMicroUsd),
                },
              ]}
            />
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-bold text-white">{m.sourcesTitle}</h4>
                <ShareList table={report.requestsBySource} labelFor={(key) => key} m={m} f={f} />
              </div>
              <div className="min-w-0">
                <h4 className="mb-2 text-sm font-bold text-white">{m.productsTitle}</h4>
                <ShareList table={report.conversationsByProduct} labelFor={(key) => key} m={m} f={f} />
              </div>
            </div>
          </section>

          <section data-testid="admin-usage-segments">
            <h3 className="text-sm font-bold text-white">{m.segmentsTitle}</h3>
            <p className="mb-3 mt-1 text-xs leading-5 text-zinc-500">{m.segmentsDescription}</p>
            <SegmentComparison
              active={report.activeSegments}
              all={report.allAccountSegments}
              labelFor={segmentLabel}
              m={m}
              f={f}
            />
            <p className="mt-3 text-xs leading-5 text-zinc-500">{m.countryNote}</p>
            <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
              <h4 className="text-sm font-bold text-white">{m.visitorsTitle}</h4>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{m.visitorsDescription}</p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <div className="min-w-0">
                  <p className="mb-2 text-xs font-bold text-zinc-400">{m.visitorCountry}</p>
                  <ShareList table={report.visitors.country} labelFor={countryLabel} m={m} f={f} />
                </div>
                <div className="min-w-0">
                  <p className="mb-2 text-xs font-bold text-zinc-400">{m.visitorLanguage}</p>
                  <ShareList table={report.visitors.language} labelFor={languageLabel} m={m} f={f} />
                </div>
              </div>
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}
