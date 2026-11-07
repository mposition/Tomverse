"use client";

import Link from "next/link";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { adminProviderBoardMessages } from "@/lib/adminMessages/providerBoard";
import {
  providerBannerSummary,
  providerCardModel,
  type ProviderCardModel,
} from "@/lib/adminProviderBoardCore";
import type { ProviderHealthRow } from "@/lib/providerMonitoring";

type Row = Pick<
  ProviderHealthRow,
  | "provider"
  | "displayName"
  | "status"
  | "apiKeyConfigured"
  | "successCount24h"
  | "failureCount24h"
  | "statusReasons"
>;

const BANNER_CLASS = {
  ok: "border-emerald-500/30 bg-emerald-500/10",
  warn: "border-amber-500/30 bg-amber-500/10",
  bad: "border-red-500/30 bg-red-500/10",
} as const;

function StatusBanner({ rows }: { rows: readonly Row[] }) {
  const m = useAdminMessages(adminProviderBoardMessages).banner;
  const summary = providerBannerSummary(rows);
  const tone = summary.outage.length > 0 ? "bad" : summary.limited.length > 0 ? "warn" : "ok";
  const title =
    summary.active === 0
      ? m.none
      : summary.healthy === summary.active
        ? m.allHealthy(summary.active)
        : m.someHealthy(summary.healthy, summary.active);
  const parts = [
    summary.outage.length > 0 ? m.outage(summary.outage.join(", ")) : null,
    summary.limited.length > 0 ? m.limited(summary.limited.join(", ")) : null,
    summary.off > 0 ? m.off(summary.off) : null,
  ].filter((part): part is string => part !== null);
  return (
    <section
      data-testid="provider-status-banner"
      data-tone={tone}
      className={`flex flex-wrap items-center gap-4 rounded-2xl border p-4 ${BANNER_CLASS[tone]}`}
    >
      <AdminPixelAvatar team="sre" unit={4} tile={64} />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-bold text-white">{title}</h2>
        <p className="mt-0.5 text-sm text-zinc-300">{parts.length > 0 ? parts.join(" ") : m.allClear}</p>
      </div>
      <Link
        href="/admin/providers?tab=incidents"
        className="inline-flex min-h-10 shrink-0 items-center rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
      >
        {m.seeIncidents}
      </Link>
    </section>
  );
}

function ShareBar({ succeeded, failed }: { succeeded: number; failed: number }) {
  const m = useAdminMessages(adminProviderBoardMessages).card;
  const total = succeeded + failed;
  return (
    <div>
      <p className="text-xs text-zinc-500">{m.shareTitle}</p>
      <div
        role="img"
        aria-label={m.shareLabel(succeeded, failed)}
        className="mt-1.5 flex h-2.5 overflow-hidden rounded-full bg-zinc-800"
      >
        {total > 0 ? (
          <>
            <span className="h-full bg-emerald-500" style={{ width: `${(succeeded / total) * 100}%` }} />
            <span className="h-full bg-red-500" style={{ width: `${(failed / total) * 100}%` }} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Fact({ label, value, warn = false }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-zinc-500">{label}</p>
      <p className={`mt-0.5 truncate text-sm font-bold tabular-nums ${warn ? "text-amber-300" : "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

function ProviderCard({ card, reason, keySet, succeeded, failed }: {
  card: ProviderCardModel;
  reason: string | null;
  keySet: boolean;
  succeeded: number;
  failed: number;
}) {
  const m = useAdminMessages(adminProviderBoardMessages);
  const c = m.card;
  return (
    <article
      data-testid={`provider-card-${card.provider}`}
      data-state={card.off ? "off" : card.status}
      className={`flex min-w-0 flex-col gap-4 rounded-2xl p-5 ${
        card.off ? "border border-dashed border-zinc-700 bg-transparent" : "border border-zinc-800 bg-zinc-900"
      }`}
    >
      <div className="flex items-center gap-3">
        <ModelLogo provider={card.provider} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold text-white">{card.displayName}</h3>
          <AdminStatusChip tone={card.tone} className="mt-1">
            {card.off ? m.state.off : m.state[card.status]}
          </AdminStatusChip>
        </div>
        {card.off ? null : (
          <Link
            href={`/admin/providers/${card.provider}`}
            className="shrink-0 text-xs font-bold text-blue-300 hover:underline"
          >
            {c.details}
          </Link>
        )}
      </div>
      {card.off ? (
        <>
          <p className="text-sm text-zinc-400">{c.offDetail}</p>
          <Link
            href="/admin/models"
            className="inline-flex min-h-10 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
          >
            {c.openModels}
          </Link>
        </>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 rounded-xl bg-zinc-950/40 p-3">
            <Fact label={c.requests} value={card.requests24h.toLocaleString("en-US")} />
            <Fact
              label={c.failed}
              value={card.failureRatePercent === null ? c.none : `${card.failureRatePercent}%`}
              warn={card.failureRatePercent !== null && card.failureRatePercent >= 5}
            />
            <Fact label={c.key} value={keySet ? c.keySet : c.keyMissing} />
          </div>
          <ShareBar succeeded={succeeded} failed={failed} />
          <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
            <span>
              {c.lastCheck}{" "}
              <span className="font-bold text-zinc-300">
                {card.checkLatencyMs === null ? c.none : c.ms(card.checkLatencyMs)}
              </span>
            </span>
            {reason ? <span className="truncate text-amber-300">{reason}</span> : null}
          </div>
        </>
      )}
    </article>
  );
}

/**
 * The top of the Status tab: one banner that says how many providers are
 * healthy, then one card per provider. It is drawn from the rows the Health
 * panel already holds and polls, so it moves with them.
 *
 * Not on the cards, because nothing the loaders return has them: response
 * time p95, the hourly status bar, the trend line and the API key expiry date.
 * The card says the 24-hour success share, the last readiness-check latency
 * and whether a key is set instead.
 */
export function ProviderStatusOverview({
  providers,
  latencyByProvider,
}: {
  providers: readonly Row[];
  latencyByProvider: Readonly<Record<string, number | null>>;
}) {
  const m = useAdminMessages(adminProviderBoardMessages);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <StatusBanner rows={providers} />
      <section aria-label={m.card.grid} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {providers.map((row) => {
          const card = providerCardModel(row, latencyByProvider[row.provider] ?? null);
          return (
            <ProviderCard
              key={row.provider}
              card={card}
              reason={row.status === "available" ? null : row.statusReasons[0]?.title || null}
              keySet={row.apiKeyConfigured}
              succeeded={row.successCount24h}
              failed={row.failureCount24h}
            />
          );
        })}
      </section>
    </div>
  );
}
