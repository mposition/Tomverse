"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminMarketingReportsMessages } from "@/lib/adminMessages/marketingReports";
import { discardResponseBody } from "@/lib/discardResponseBody";
import type { MarketingMorningReport } from "@/lib/marketingAnalysisCore";

/**
 * The operator's morning report (owner request 2026-11-03): the newest one
 * the generator wrote (lib/marketingMorningCore.ts), at the top of the
 * Reports tab. The figures are code's counts; the sentences are the model's.
 */

type Messages = Record<keyof (typeof adminMarketingReportsMessages)["en"], string>;

type Load =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "none" }
  | { status: "unreadable" }
  | { status: "found"; current: boolean; createdAt: string; morning: MarketingMorningReport };

/** A time on the operator's clock (Brisbane, no daylight saving). */
export const brisbaneStamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Date(date.getTime() + 10 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16)} AEST`;
};

const sectionLabel = (m: Messages, section: MarketingMorningReport["decisions"][number]["section"]) =>
  ({
    queue: m.sectionQueue,
    published: m.sectionPublished,
    accounts: m.sectionAccounts,
    assets: m.sectionAssets,
    competitors: m.sectionCompetitors,
    reports: m.sectionReports,
    experiments: m.sectionExperiments,
    comments: m.sectionComments,
  })[section];

const actionLabel = (m: Messages, action: MarketingMorningReport["adjust"][number]["action"]) =>
  ({ stop: m.actionStop, reduce: m.actionReduce, increase: m.actionIncrease, keep: m.actionKeep })[action];

const actionTone = {
  stop: "text-rose-300",
  reduce: "text-rose-300",
  increase: "text-emerald-300",
  keep: "text-sky-300",
} as const;

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold text-white">{value}</p>
    </div>
  );
}

export function MarketingMorningView({ morning }: { morning: MarketingMorningReport }) {
  const m = useAdminMessages(adminMarketingReportsMessages);
  const f = morning.figures;
  const usd = (micro: number) => `US$${(micro / 1_000_000).toFixed(2)}`;
  return (
    <div className="grid gap-4" data-testid="marketing-morning">
      <p className="rounded-xl border-l-4 border-amber-300 bg-zinc-950/60 px-4 py-3 text-[15px] font-semibold leading-6 text-white">
        {morning.verdict}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="marketing-morning-figures">
        <Figure label={m.figPending} value={String(f.pendingApproval)} />
        <Figure label={m.figApprovedWaiting} value={String(f.approvedWaiting)} />
        <Figure label={m.figPublished} value={`${f.published7d} / ${f.sent7d}`} />
        <Figure label={m.figFailed} value={String(f.failed7d)} />
        <Figure label={m.figTouches} value={f.touches7d === null ? m.unreadable : String(f.touches7d)} />
        <Figure label={m.figSignups} value={f.signupsAttributed7d === null ? m.unreadable : String(f.signupsAttributed7d)} />
        <Figure
          label={m.figLlm}
          value={
            f.llmCountedMicroUsd === null
              ? m.unreadable
              : `${usd(f.llmCountedMicroUsd)}${f.llmCapUsd === null ? "" : ` / US$${f.llmCapUsd}`}`
          }
        />
        <Figure label={m.figPublish} value={f.publishEnabled === null ? m.unreadable : f.publishEnabled ? m.on : m.off} />
      </div>
      {f.nextApprovalExpiryAt ? (
        <p className="-mt-2 text-xs text-zinc-500">{m.figExpiry.replace("{time}", brisbaneStamp(f.nextApprovalExpiryAt))}</p>
      ) : null}

      {morning.decisions.length > 0 ? (
        <section>
          <h4 className="text-sm font-semibold text-zinc-100">{m.morningDecisions}</h4>
          <ol className="mt-1 grid gap-2">
            {morning.decisions.map((decision, index) => (
              <li
                key={index}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-2 first:border-t-0 first:pt-0"
                data-testid="marketing-morning-decision"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-white">
                    {index + 1}. {decision.title}
                  </p>
                  <p className="text-xs leading-5 text-zinc-400">{decision.why}</p>
                </div>
                <Link
                  href={`/admin/marketing?tab=${decision.section}`}
                  className="inline-flex min-h-10 items-center rounded-lg border border-zinc-700 px-3 text-[13px] font-semibold text-zinc-200 hover:bg-zinc-800"
                >
                  {sectionLabel(m, decision.section)} {m.open}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section>
        <h4 className="text-sm font-semibold text-zinc-100">{m.morningWorked}</h4>
        <p className="mt-1 text-[13px] leading-5 text-zinc-200">{morning.worked}</p>
      </section>

      {morning.adjust.length > 0 ? (
        <section>
          <h4 className="text-sm font-semibold text-zinc-100">{m.morningAdjust}</h4>
          <ul className="mt-1 grid gap-1.5">
            {morning.adjust.map((entry, index) => (
              <li key={index} className="grid grid-cols-[56px_1fr] gap-2 text-[13px] leading-5">
                <span className={`font-semibold ${actionTone[entry.action]}`}>{actionLabel(m, entry.action)}</span>
                <span className="text-zinc-200">
                  <span className="font-semibold text-white">{entry.what}</span> — {entry.why}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {morning.marketChanges.length > 0 ? (
        <section>
          <h4 className="text-sm font-semibold text-zinc-100">{m.morningMarket}</h4>
          <ul className="mt-1 grid gap-1.5">
            {morning.marketChanges.map((entry, index) => (
              <li key={index} className="grid grid-cols-[96px_1fr] gap-2 text-[13px] leading-5">
                <span className="font-mono text-xs text-zinc-400">{entry.competitorId}</span>
                <span className="text-zinc-200">
                  {entry.change} <span className="text-zinc-400">→ {entry.action}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-zinc-500">
        {m.morningNote} · {morning.promptVersion}
      </p>
    </div>
  );
}

/** The newest morning report, at the top of the Reports tab. */
export function MarketingMorningCard() {
  const m = useAdminMessages(adminMarketingReportsMessages);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const read = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/marketing/morning", { cache: "no-store" });
      if (!response.ok) {
        await discardResponseBody(response);
        setLoad({ status: "failed" });
        return;
      }
      const body = (await response.json()) as Load;
      // A found body without the report it names is a failed load, not a render that throws.
      const usable =
        body.status === "none" ||
        body.status === "unreadable" ||
        (body.status === "found" && Array.isArray(body.morning?.decisions) && typeof body.morning.verdict === "string");
      setLoad(usable ? body : { status: "failed" });
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
    <section data-testid="marketing-morning-card" className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-white">
          {m.morningTitle}
          {load.status === "found" ? (
            <span className="ml-2 text-sm font-normal text-zinc-400">{load.morning.date}</span>
          ) : null}
        </h3>
        {load.status === "found" ? (
          <span className="text-xs text-zinc-500">{m.written.replace("{time}", brisbaneStamp(load.createdAt))}</span>
        ) : null}
      </div>
      <div className="mt-3">
        {load.status === "loading" ? (
          <p className="text-sm text-zinc-400">{m.loading}</p>
        ) : load.status === "failed" ? (
          <p className="text-sm text-amber-300">{m.loadFailed}</p>
        ) : load.status === "unreadable" ? (
          <p className="text-sm text-amber-300">{m.unreadable}</p>
        ) : load.status === "none" ? (
          <p className="text-sm text-zinc-400">{m.morningNone}</p>
        ) : (
          <>
            {load.current ? null : (
              <p className="mb-3 text-sm text-amber-300" data-testid="marketing-morning-stale">
                {m.morningStale}
              </p>
            )}
            <MarketingMorningView morning={load.morning} />
          </>
        )}
      </div>
    </section>
  );
}
