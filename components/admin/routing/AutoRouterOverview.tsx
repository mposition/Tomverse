"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, MessageCircle, Route } from "lucide-react";
import { ModelLogo } from "@/components/chat/ModelLogo";
import {
  AdminAutoLlmRouterPanel,
  type AutoRouterModelState,
} from "@/components/admin/AdminAutoLlmRouterPanel";
import type { ShadowReport } from "@/components/admin/AdminRoutingShadowPanel";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminFetch } from "@/lib/adminFetch";
import { adminIntlLocale, type AdminLocale } from "@/lib/adminLocale";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";
import { discardResponseBody } from "@/lib/discardResponseBody";

const WINDOW_DAYS = 7;

const num = (value: number, locale: AdminLocale) => value.toLocaleString(adminIntlLocale(locale));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const ms = (micros: number) => `${(micros / 1000).toFixed(1)}ms`;

/**
 * The shadow report's request kinds as shares of what was decided. A kind with
 * nothing decided has no share to draw, so it is left out rather than shown as 0%.
 */
export function autoRouterKindShares(report: Pick<ShadowReport, "byTaskKind">) {
  const total = report.byTaskKind.reduce((sum, group) => sum + group.decided, 0);
  if (total === 0) return [];
  return report.byTaskKind
    .filter((group) => group.decided > 0)
    .map((group) => ({
      key: group.key,
      share: group.decided / total,
      agreementRate: group.agreementRate,
    }))
    .sort((left, right) => right.share - left.share);
}

/**
 * The shadow comparison as three parts of the runs that were recorded: the
 * user's model would have been kept, Auto would have moved it, or no allowed
 * model was left. Null when nothing was recorded, so no empty bar is drawn.
 */
export function autoRouterShadowSplit(
  report: Pick<ShadowReport, "agreed" | "decided" | "undecided">
) {
  const total = report.decided + report.undecided;
  if (total === 0) return null;
  const switched = Math.max(0, report.decided - report.agreed);
  return {
    total,
    parts: [
      { key: "agreed", count: report.agreed, share: report.agreed / total },
      { key: "switched", count: switched, share: switched / total },
      { key: "noCandidate", count: report.undecided, share: report.undecided / total },
    ] as const,
  };
}

const PART_BAR: Record<"agreed" | "switched" | "noCandidate", string> = {
  agreed: "bg-emerald-500",
  switched: "bg-amber-500",
  noCandidate: "bg-zinc-500",
};

function FlowStep({
  icon,
  title,
  detail,
  chip,
  testId,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  detail: React.ReactNode;
  chip?: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-w-0 flex-col items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4 text-center lg:w-48"
    >
      {icon}
      <p className="max-w-full truncate text-sm font-bold text-zinc-100">{title}</p>
      <p className="text-xs text-zinc-500">{detail}</p>
      {chip}
    </div>
  );
}

/**
 * The Auto router at a glance: how a message flows through it, four numbers
 * and the shadow comparison as one bar. It draws what the shadow report holds
 * and nothing it does not: the receiving model of each kind and the router's
 * own cost are not recorded, so they are not drawn.
 */
export function AutoRouterOverviewView({
  router,
  report,
  failed,
  loading,
  onRetry,
}: {
  router: AutoRouterModelState;
  report: ShadowReport | null;
  failed: boolean;
  loading: boolean;
  onRetry: () => void;
}) {
  const m = useAdminMessages(adminRoutingScreensMessages);
  const { locale } = useAdminLocale();
  const o = m.overview;
  const shares = report ? autoRouterKindShares(report) : [];
  const split = report ? autoRouterShadowSplit(report) : null;
  const kindLabel = (key: string) =>
    (o.kinds as Record<string, string>)[key] ?? key.replaceAll("_", " ");

  const routerStep =
    router === "unknown" ? (
      <FlowStep
        testId="admin-auto-router-flow-router"
        icon={<Route className="h-6 w-6 text-zinc-500" aria-hidden />}
        title={o.router}
        detail={o.routerUnknown}
        chip={<AdminStatusChip tone="unknown" />}
      />
    ) : router === "off" ? (
      <FlowStep
        testId="admin-auto-router-flow-router"
        icon={<Route className="h-6 w-6 text-zinc-500" aria-hidden />}
        title={o.router}
        detail={o.routerOffDetail}
        chip={<AdminStatusChip tone="idle">{o.routerOff}</AdminStatusChip>}
      />
    ) : (
      <FlowStep
        testId="admin-auto-router-flow-router"
        icon={<ModelLogo provider={router.provider} size="lg" />}
        title={router.name}
        detail={o.routerDetail}
        chip={<AdminStatusChip tone="ok">{o.routerOn}</AdminStatusChip>}
      />
    );

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-auto-router-overview">
      <AdminTile
        title={o.title}
        description={report ? o.description(report.windowDays, num(report.rows, locale)) : undefined}
      >
        <div className="flex flex-col items-stretch gap-4 lg:flex-row lg:items-center">
          <FlowStep
            testId="admin-auto-router-flow-question"
            icon={<MessageCircle className="h-6 w-6 text-blue-300" aria-hidden />}
            title={o.question}
            detail={o.questionDetail}
          />
          <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-zinc-500 lg:rotate-0" aria-hidden />
          {routerStep}
          <ArrowRight className="mx-auto h-5 w-5 shrink-0 rotate-90 text-zinc-500 lg:rotate-0" aria-hidden />
          <div className="min-w-0 flex-1" data-testid="admin-auto-router-kinds">
            <p className="mb-2 text-xs font-bold text-zinc-400">{o.kindsTitle}</p>
            {failed ? (
              <AdminStateBlock kind="error" title={o.readFailed} detail={o.readFailedDetail} onRetry={onRetry} />
            ) : loading && !report ? (
              <AdminStateBlock kind="loading" />
            ) : shares.length === 0 ? (
              <AdminStateBlock kind="empty" title={o.kindsEmpty} />
            ) : (
              <ul className="flex flex-col gap-2">
                {shares.map((row) => (
                  <li
                    key={row.key}
                    className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 rounded-xl border border-zinc-800 px-3 py-2 text-sm"
                  >
                    <span className="truncate font-bold text-zinc-100">{kindLabel(row.key)}</span>
                    <span className="flex items-center gap-2">
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                        <span
                          className="block h-full rounded-full bg-blue-500"
                          style={{ width: `${Math.max(2, row.share * 100)}%` }}
                        />
                      </span>
                      <span className="w-12 text-right font-bold tabular-nums text-zinc-100">
                        {pct(row.share)}
                      </span>
                    </span>
                    <span className="hidden text-xs text-zinc-500 sm:inline">
                      {row.agreementRate === null ? "—" : o.kindAgreement(pct(row.agreementRate))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </AdminTile>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="admin-auto-router-kpis">
        <AdminKpiCard
          label={o.kpiRuns}
          value={report ? num(report.rows, locale) : null}
          detail={o.kpiRunsDetail(report ? report.windowDays : WINDOW_DAYS)}
          onRetry={failed ? onRetry : undefined}
        />
        <AdminKpiCard
          label={o.kpiAgreement}
          value={report ? (report.agreementRate === null ? "—" : pct(report.agreementRate)) : null}
          detail={
            report ? o.kpiAgreementDetail(num(report.agreed, locale), num(report.decided, locale)) : undefined
          }
          onRetry={failed ? onRetry : undefined}
        />
        <AdminKpiCard
          label={o.kpiNoCandidate}
          value={report ? num(report.undecided, locale) : null}
          detail={o.kpiNoCandidateDetail}
          onRetry={failed ? onRetry : undefined}
        />
        <AdminKpiCard
          label={o.kpiLatency}
          value={report ? ms(report.decisionMicrosP95) : null}
          detail={o.kpiLatencyDetail}
          onRetry={failed ? onRetry : undefined}
        />
      </div>

      <AdminTile
        title={m.summary.title}
        description={m.summary.description}
        action={
          <Link
            href="/admin/routing?tab=shadow"
            className="inline-flex min-h-9 items-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
          >
            {m.summary.openTab}
          </Link>
        }
        data-testid="admin-auto-router-shadow-summary"
      >
        {failed ? (
          <AdminStateBlock kind="error" title={o.readFailed} onRetry={onRetry} />
        ) : loading && !report ? (
          <AdminStateBlock kind="loading" />
        ) : split === null ? (
          <AdminStateBlock kind="empty" title={m.summary.empty} detail={m.summary.emptyDetail} />
        ) : (
          <>
            <div
              className="flex h-4 w-full gap-0.5 overflow-hidden rounded-full"
              role="img"
              aria-label={split.parts
                .map((part) => `${m.summary[part.key]} ${pct(part.share)}`)
                .join(", ")}
            >
              {split.parts
                .filter((part) => part.count > 0)
                .map((part) => (
                  <span
                    key={part.key}
                    className={`block h-full ${PART_BAR[part.key]}`}
                    style={{ flexGrow: part.count, flexBasis: 0 }}
                  />
                ))}
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-300">
              {split.parts.map((part) => (
                <li key={part.key} className="flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-sm ${PART_BAR[part.key]}`} aria-hidden />
                  {m.summary[part.key]}
                  <span className="font-bold tabular-nums text-zinc-100">
                    {pct(part.share)} ({num(part.count, locale)})
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </AdminTile>
    </div>
  );
}

/**
 * The Auto router tab: the overview, then the settings that change the
 * router. The settings panel reports its model upward after every read and
 * save, so the flow always names the model that is actually saved.
 */
export function AutoRouterTab({ canWrite }: { canWrite: boolean }) {
  const [router, setRouter] = useState<AutoRouterModelState>("unknown");
  const [report, setReport] = useState<ShadowReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setFailed(false);
      const response = await adminFetch(`/api/admin/routing-shadow?days=${WINDOW_DAYS}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      setReport((await response.json()) as ShadowReport);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so no state write is synchronous within the effect.
    queueMicrotask(() => void load());
  }, [load]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AutoRouterOverviewView
        router={router}
        report={report}
        failed={failed}
        loading={loading}
        onRetry={() => void load()}
      />
      <AdminAutoLlmRouterPanel
        canWrite={canWrite}
        onModelChange={setRouter}
      />
    </div>
  );
}
