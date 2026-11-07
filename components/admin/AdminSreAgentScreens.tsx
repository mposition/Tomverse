"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminBars } from "@/components/admin/ui/AdminCharts";
import { AdminDataTable } from "@/components/admin/ui/AdminDataTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminSreOpsMessages } from "@/lib/adminMessages/sreOps";
import { adminSreOpsAgentMessages } from "@/lib/adminMessages/sreOpsAgent";
import type { SreDailySummary } from "@/lib/adminSreDailyCore";
import { formatAestDateTime } from "@/lib/adminUiCore";
import type { OpsObserverDigestView } from "@/lib/opsObserverDigest";
import type { OpsObserverAdminView } from "@/lib/opsObserverStore";

const DAILY_HREF = (id?: string) => `/admin/sre-ops?tab=daily${id ? `&item=${encodeURIComponent(id)}` : ""}`;

/** The Overview's four numbers and the alert trend, above the chain and the genesis control. */
export function AdminSreOverviewSummary({
  view,
  summaries,
}: {
  view: OpsObserverAdminView | null;
  /** The recent daily reports, newest first; null when they could not be read. */
  summaries: readonly SreDailySummary[] | null;
}) {
  const m = useAdminMessages(adminSreOpsAgentMessages);
  const latest = summaries?.find((row) => !row.bodyGone) ?? null;
  const chainValue = !view ? null : !view.head ? m.kpi.chainNone : view.trustReason === "trusted" ? m.kpi.chainTrusted : m.kpi.chainUntrusted;
  const mode = view?.head?.mode ?? null;
  const modeValue = !view ? null : mode === "shadow" ? m.kpi.modeShadow : mode === "live" ? m.kpi.modeLive : mode ? mode : m.kpi.modeNone;
  const trend = summaries ? summaries.filter((row) => row.total !== null).map((row) => row.total as number).reverse() : [];
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="sre-overview-summary">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={m.kpi.chain}
          value={chainValue}
          tone={view?.head && view.trustReason !== "trusted" ? "bad" : "neutral"}
          detail={view?.head && view.trustReason !== "trusted" ? m.kpi.chainDetail(view.trustReason) : undefined}
        />
        <AdminKpiCard
          label={m.kpi.mode}
          value={modeValue}
          detail={mode === "shadow" ? m.kpi.modeShadowDetail : mode === "live" ? m.kpi.modeLiveDetail : undefined}
        />
        <AdminKpiCard
          label={m.kpi.messages}
          value={summaries === null ? null : latest ? (latest.total ?? null) : null}
          detail={latest?.ownerDate ? m.kpi.messagesDetail(latest.ownerDate) : undefined}
          tone={latest && (latest.total ?? 0) > 0 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.kpi.failing}
          value={summaries === null || !latest || latest.failingChecks === null ? null : latest.failingChecks.length}
          detail={
            latest?.failingChecks
              ? latest.failingChecks.length > 0
                ? m.kpi.failingDetail(latest.failingChecks.join(", "))
                : m.kpi.failingNone
              : undefined
          }
          tone={latest?.failingChecks && latest.failingChecks.length > 0 ? "bad" : "neutral"}
        />
      </div>
      {trend.length >= 2 ? (
        <AdminTile title={m.trend.title} description={m.trend.description(trend.length)}>
          <AdminBars values={trend} width={600} height={72} highlight={trend.length - 1} label={m.trend.title} className="w-full" />
        </AdminTile>
      ) : null}
    </div>
  );
}

/** The date list and, when a report is open, its readable body. */
export function AdminSreDaily({
  summaries,
  selected,
  requestedId,
  limit,
}: {
  /** The recent reports, newest first; null when the list could not be read. */
  summaries: readonly SreDailySummary[] | null;
  /** The open report, from the list or read on its own; null when none is open or it is not there. */
  selected: OpsObserverDigestView | null;
  requestedId: string | null;
  limit: number;
}) {
  const m = useAdminMessages(adminSreOpsAgentMessages);
  if (summaries === null && !selected) {
    return <AdminStateBlock kind="error" title={m.daily.listFailed} />;
  }
  const list = summaries ?? [];
  const summaryText = (row: SreDailySummary) =>
    row.bodyGone
      ? m.daily.bodyGone
      : row.quiet
        ? m.daily.quiet
        : [
            (row.total ?? 0) > 0 ? m.daily.alerts(row.total ?? 0) : null,
            row.failingChecks && row.failingChecks.length > 0 ? m.daily.checksFailing(row.failingChecks.length) : null,
            row.readinessUnknown ? m.daily.checksUnknown : null,
            row.countsComplete ? null : m.daily.partialChip,
          ]
            .filter(Boolean)
            .join(" · ");
  const dateLabel = (row: SreDailySummary) => row.ownerDate ?? formatAestDateTime(row.createdAt) ?? "-";

  if (!requestedId) {
    return (
      <div data-testid="sre-daily-list">
        <AdminDataTable
          caption={m.daily.listTitle}
          rows={list}
          rowKey={(row) => row.id}
          toolbar={<p className="text-sm text-zinc-400">{m.daily.listDescription(limit)}</p>}
          emptyState={<AdminStateBlock kind="empty" title={m.daily.listEmpty} />}
          columns={[
            {
              key: "date",
              header: m.daily.date,
              render: (row) => (
                <Link href={DAILY_HREF(row.id)} className="font-bold text-blue-300 hover:underline">
                  {dateLabel(row)}
                </Link>
              ),
            },
            {
              key: "summary",
              header: m.daily.summary,
              render: (row) => <AdminStatusChip tone={row.tone}>{summaryText(row)}</AdminStatusChip>,
            },
            { key: "recorded", header: m.daily.recorded, render: (row) => formatAestDateTime(row.createdAt) ?? "-" },
          ]}
          cardTitle={(row) => (
            <Link href={DAILY_HREF(row.id)} className="font-bold text-blue-300">
              {dateLabel(row)}
            </Link>
          )}
          cardMeta={(row) => summaryText(row)}
        />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]" data-testid="sre-daily">
      <nav aria-label={m.daily.listTitle} className="flex min-w-0 flex-col gap-1 rounded-2xl border border-zinc-800 bg-zinc-900 p-2">
        {list.map((row) => {
          const active = row.id === requestedId;
          return (
            <Link
              key={row.id}
              href={DAILY_HREF(row.id)}
              aria-current={active ? "page" : undefined}
              className={`flex min-w-0 flex-col rounded-xl px-3 py-2 text-sm ${
                active ? "bg-blue-500/15 text-blue-200" : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <span className="flex items-center gap-2 font-bold">
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    row.tone === "ok" ? "bg-emerald-500" : row.tone === "warn" ? "bg-amber-500" : "bg-zinc-500"
                  }`}
                />
                {dateLabel(row)}
              </span>
              <span className="text-xs text-zinc-500">{summaryText(row)}</span>
            </Link>
          );
        })}
        <Link href={DAILY_HREF()} className="px-3 py-2 text-xs font-bold text-blue-300 hover:underline">
          {m.daily.back}
        </Link>
      </nav>
      {selected ? <SreDailyReport view={selected} /> : <AdminStateBlock kind="empty" title={m.daily.notFound} />}
    </div>
  );
}

function SreDailyReport({ view }: { view: OpsObserverDigestView }) {
  const m = useAdminMessages(adminSreOpsAgentMessages);
  const legacy = useAdminMessages(adminSreOpsMessages);
  const label = (prefix: string, value: string) => (legacy as Record<string, unknown>)[`${prefix}_${value}`] as string | undefined ?? value;
  const payload = view.payload;
  if (!payload) {
    return (
      <AdminTile as="article">
        <AdminStateBlock kind="empty" title={m.daily.goneTitle} detail={m.daily.goneDetail} />
      </AdminTile>
    );
  }
  const total = payload.counts.reduce((sum, row) => sum + row.count, 0);
  const failing = payload.readiness === "unknown" ? [] : Object.entries(payload.readiness).filter(([, ok]) => !ok).map(([name]) => name);
  const unknownChecks = payload.readiness === "unknown";
  const partial = !view.countsComplete;
  // An older report cannot prove nothing was held back, so it is never drawn as a quiet day.
  const quiet = total === 0 && failing.length === 0 && !unknownChecks && !partial;
  return (
    <AdminTile as="article" className="gap-5" data-testid="sre-daily-report">
      <div className="flex min-w-0 items-start gap-4">
        <AdminPixelAvatar team="sre" unit={3} tile={64} body={false} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500">
            {m.daily.reportBy(payload.ownerDate)} · {formatAestDateTime(view.createdAt) ?? "-"}
          </p>
          <h3 className="text-xl font-bold text-white">
            {quiet ? m.daily.quietTitle : partial && total === 0 && failing.length === 0 ? m.daily.partialTitle : m.daily.busyTitle}
          </h3>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            {quiet
              ? m.daily.quietDetail
              : partial && total === 0 && failing.length === 0
                ? m.daily.partialCounts
                : m.daily.busyDetail(total, failing.length)}
          </p>
        </div>
        <AdminStatusChip tone={quiet ? "ok" : "warn"}>
          {quiet ? m.daily.quiet : partial && total === 0 ? m.daily.partialChip : m.daily.alerts(total)}
        </AdminStatusChip>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard label={m.daily.cardMode} value={payload.mode} />
        <AdminKpiCard label={m.daily.cardAlerts} value={total} tone={total > 0 ? "warn" : "neutral"} />
        <AdminKpiCard label={m.daily.cardFailing} value={unknownChecks ? null : failing.length} tone={failing.length > 0 ? "bad" : "neutral"} />
        <AdminKpiCard label={m.daily.cardChannel} value={payload.channelCheckTaken ? m.daily.channelDone : m.daily.channelNotDone} />
      </div>

      <section className="flex min-w-0 flex-col gap-2">
        <h4 className="text-base font-bold text-white">{m.daily.lookAt}</h4>
        {unknownChecks ? <AdminStateBlock kind="error" title={m.daily.unknownChecks} /> : null}
        {failing.map((name) => (
          <div key={name} className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-bold">{m.daily.failingCheck}</p>
            <p className="mt-0.5 font-mono text-xs text-amber-300">{name}</p>
          </div>
        ))}
        {total > 0 ? (
          <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <p className="font-bold">{m.daily.alerts(total)}</p>
            {payload.mode === "shadow" ? <p className="mt-0.5 text-xs text-amber-300">{m.daily.shadowNote}</p> : null}
          </div>
        ) : null}
        {!view.countsComplete ? <p className="text-xs text-amber-300">{m.daily.partialCounts}</p> : null}
        {quiet ? <AdminStateBlock kind="empty" title={m.daily.nothingToLookAt} /> : null}
      </section>

      {total > 0 ? (
        <AdminTechInfo summary={m.daily.techSummary}>
          <ul className="mb-3 flex flex-col gap-1">
            {payload.counts.map((row) => (
              <li key={`${row.mode}-${row.status}-${row.kind}`}>
                {row.mode} · {label("itemStatus", row.status)} · {label("kind", row.kind)} {row.count}
              </li>
            ))}
          </ul>
          {total > payload.items.length ? <p className="mb-2">{m.daily.showing(payload.items.length, total)}</p> : null}
          <AdminDataTable
            caption={m.daily.messagesTitle}
            rows={payload.items}
            rowKey={(item) => `${item.key}-${item.kind}-${item.status}-${item.mode}`}
            columns={[
              { key: "signal", header: m.daily.colSignal, render: (item) => item.key },
              { key: "kind", header: m.daily.colKind, render: (item) => label("kind", item.kind) },
              { key: "mode", header: m.daily.colMode, render: (item) => item.mode },
              { key: "status", header: m.daily.colStatus, render: (item) => label("itemStatus", item.status) },
              { key: "capped", header: m.daily.colCapped, render: (item) => (item.capped ? m.daily.yes : m.daily.no) },
            ]}
            cardTitle={(item) => item.key}
            cardMeta={(item) => `${label("kind", item.kind)} · ${label("itemStatus", item.status)}`}
          />
        </AdminTechInfo>
      ) : null}
    </AdminTile>
  );
}

/** The Settings tab: the mode in plain words, the contact path, and the chain's ids closed. */
export function AdminSreSettings({ view }: { view: OpsObserverAdminView | null }) {
  const m = useAdminMessages(adminSreOpsAgentMessages);
  if (!view) return <AdminStateBlock kind="error" title={m.readFailed} />;
  const mode = view.head?.mode ?? null;
  const active = mode === "shadow" ? "shadow" : mode === "live" ? "live" : "none";
  const options = [
    { id: "shadow", title: m.settings.shadowTitle, body: m.settings.shadowBody },
    { id: "live", title: m.settings.liveTitle, body: m.settings.liveBody },
    { id: "none", title: m.settings.noneTitle, body: m.settings.noneBody },
  ] as const;
  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2" data-testid="sre-settings">
      <AdminTile title={m.settings.modeTitle} description={m.settings.modeDescription}>
        <ul className="flex flex-col gap-2">
          {options
            .filter((option) => option.id !== "none" || active === "none")
            .map((option) => (
              <li
                key={option.id}
                data-active={option.id === active ? "true" : undefined}
                className={`rounded-xl border p-3 ${
                  option.id === active ? "border-blue-500/50 bg-blue-500/10" : "border-zinc-800"
                }`}
              >
                <p className="text-sm font-bold text-zinc-100">{option.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-zinc-400">{option.body}</p>
              </li>
            ))}
        </ul>
        <p className="text-xs leading-5 text-zinc-400">{m.settings.changeMode}</p>
        <Link href="/admin/sre-ops?tab=overview" className="self-start text-sm font-bold text-blue-300 hover:underline">
          {m.settings.goOverview}
        </Link>
      </AdminTile>
      <div className="flex min-w-0 flex-col gap-4">
        <AdminTile title={m.settings.contactTitle} description={m.settings.contactDescription}>
          <ul className="flex flex-col gap-2 text-sm leading-6 text-zinc-300">
            <li>{m.settings.contactAlerts}</li>
            <li>{m.settings.contactDaily}</li>
            <li>{m.settings.contactSilence}</li>
          </ul>
        </AdminTile>
        {view.head ? (
          <AdminTechInfo summary={m.settings.techSummary}>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
              <dt>{m.settings.techGenesis}</dt>
              <dd className="break-all">{view.head.genesisId}</dd>
              <dt>{m.settings.techGeneration}</dt>
              <dd>{view.head.generation ?? m.settings.techNone}</dd>
              <dt>{m.settings.techApproved}</dt>
              <dd>{formatAestDateTime(view.head.createdAt) ?? m.settings.techNone}</dd>
              <dt>{m.settings.techNext}</dt>
              <dd>{formatAestDateTime(view.nextGenesisAt) ?? m.settings.techNone}</dd>
            </dl>
          </AdminTechInfo>
        ) : null}
      </div>
    </div>
  );
}
