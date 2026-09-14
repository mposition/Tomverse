import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, XCircle } from "lucide-react";
import { AdminSnapshotActions } from "@/components/admin/AdminSnapshotActions";
import type { AdminEnvCheck } from "@/lib/adminEnvironmentChecks";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";

/**
 * The whole Overview page, as one structure.
 *
 * Before this, Overview rendered the same four facts four times: the operations
 * panel carried a KPI strip, a "Needs attention" list and a full environment
 * table; a second KPI grid repeated three of its five numbers; a second
 * "Needs attention" section repeated the list verbatim; and an "Environment
 * health" card repeated fourteen of the variable names with no status beside
 * them. An operator reading top to bottom met each number twice and could not
 * tell which copy was authoritative. Each fact now appears once, in the section
 * that owns it.
 */

export type AttentionItem = {
  title: string;
  detail: string;
  tone: "red" | "amber" | "blue" | "zinc";
  href: string;
};

type Kpi = {
  label: string;
  /**
   * Null when the read behind it failed.
   *
   * Not `"0"`, and not an empty string: the page's reads are settled
   * individually now, and the cheapest way to lose that is a `?? 0` in a
   * caller. A card that cannot be given a number renders as unread, which is
   * a different statement from zero and leads somewhere different.
   */
  value: string | null;
  detail: string;
  tone?: "zinc" | "blue" | "emerald" | "amber" | "purple";
};

const toneClass = (tone: Kpi["tone"]) =>
  tone === "blue"
    ? "border-blue-500/25 bg-blue-500/10"
    : tone === "emerald"
      ? "border-emerald-500/25 bg-emerald-500/10"
      : tone === "amber"
        ? "border-amber-500/25 bg-amber-500/10"
        : tone === "purple"
          ? "border-purple-500/25 bg-purple-500/10"
          : "border-zinc-800 bg-zinc-900/60";

const attentionToneClass = (tone: AttentionItem["tone"]) =>
  tone === "red"
    ? "border-red-500/30 bg-red-500/10"
    : tone === "amber"
      ? "border-amber-500/30 bg-amber-500/10"
      : tone === "blue"
        ? "border-blue-500/30 bg-blue-500/10"
        : "border-zinc-800 bg-zinc-900/70";

function KpiCard({
  label,
  value,
  detail,
  tone,
  unreadableLabel,
}: Kpi & { unreadableLabel: string }) {
  const unread = value === null;
  return (
    <div
      className={`rounded-2xl border p-4 ${
        unread ? "border-zinc-700 border-dashed bg-zinc-900/40" : toneClass(tone)
      }`}
      data-testid={unread ? "admin-kpi-unreadable" : undefined}
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
        {label}
      </p>
      {/*
        The unread state is deliberately not a big dash or an empty card. Both
        read as "nothing here", which is the reading this exists to prevent --
        it has to say that the figure is unknown, in words, at the size the
        figure would have been.
      */}
      <p
        className={
          unread
            ? "mt-2 text-sm font-bold text-zinc-400"
            : "mt-2 text-2xl font-black text-white"
        }
      >
        {unread ? unreadableLabel : value}
      </p>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{detail}</p>
    </div>
  );
}

export async function AdminOverviewSummary({
  generatedAt,
  adminRole,
  healthScore,
  healthScoreIncomplete,
  unreadableReads,
  operationalKpis,
  commercialKpis,
  needsAttention,
  envChecks,
  blockingEnvCount,
  processStartedAt,
  recentActivity,
  recentActivityLimit,
  snapshotReport,
}: {
  generatedAt: string;
  adminRole: string;
  healthScore: number;
  /** True when a score input could not be read, so the score is a ceiling. */
  healthScoreIncomplete: boolean;
  /** Human names of the reads that did not come back, if any. */
  unreadableReads: string[];
  operationalKpis: Kpi[];
  commercialKpis: Kpi[];
  needsAttention: AttentionItem[];
  envChecks: AdminEnvCheck[];
  /** Missing rows that actually deduct. Never every unset variable. */
  blockingEnvCount: number;
  /** When the process answering this request started, `YYYY-MM-DD HH:MM`. */
  processStartedAt: string;
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
  const { summary: m } = await getAdminMessages(adminOverviewMessages);
  const missingEnv = envChecks.filter((check) => !check.configured);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-black text-white">{m.snapshotTitle}</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              {m.generated(generatedAt, adminRole)}
            </p>
          </div>
          <AdminSnapshotActions report={snapshotReport} />
        </div>

        {/*
          Named, not counted. "Something could not be loaded" tells an operator
          to distrust the whole screen; naming the read tells them which figure
          to distrust and leaves the rest usable -- which is the entire point of
          settling these reads separately rather than failing the page.
        */}
        {unreadableReads.length > 0 ? (
          <div
            className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
            role="status"
            data-testid="admin-overview-unreadable-reads"
          >
            <p className="flex items-center gap-2 text-sm font-bold text-amber-100">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {m.readsFailedTitle(unreadableReads.length)}
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-100/80">
              {m.readsFailedDetail(unreadableReads.join(", "))}
            </p>
          </div>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {/*
            A link, not a card. The score is six weighted counts and a table of
            twenty-nine variables collapsed into one integer, and an operator
            reading it had nowhere to go to find out which. `?tab=health`
            renders the arithmetic that produced this number.
          */}
          <Link
            href="/admin/overview?tab=health"
            data-testid="admin-health-score-link"
            className="rounded-2xl border border-blue-500/25 bg-blue-500/10 p-4 transition hover:border-blue-400/50"
          >
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              {m.healthScore}
            </p>
            <p className="mt-2 text-2xl font-black text-white">{healthScore}</p>
            <p className="mt-1 text-xs leading-5 text-zinc-400">
              {m.healthScoreDetail}
            </p>
            {healthScoreIncomplete ? (
              <p
                className="mt-1 text-xs font-bold text-amber-200"
                data-testid="admin-health-score-incomplete"
              >
                {m.healthScoreIncomplete}
              </p>
            ) : null}
            <p className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-blue-300">
              {m.explainScore}
              <ArrowRight className="h-3 w-3" aria-hidden />
            </p>
          </Link>
          {operationalKpis.map((kpi) => (
            <KpiCard key={kpi.label} {...kpi} unreadableLabel={m.unreadable} />
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h2 className="text-xl font-black text-white">{m.revenueTitle}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          {m.revenueDescription}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {commercialKpis.map((kpi) => (
            <KpiCard key={kpi.label} {...kpi} unreadableLabel={m.unreadable} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-black text-white">{m.launchQueueTitle}</h2>
            <Link
              href="/admin/work-queue"
              className="text-xs font-bold text-blue-300 hover:text-blue-200"
            >
              {m.openWorkQueue}
            </Link>
          </div>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            {m.launchQueueDescription}
          </p>
          <div className="mt-5 grid gap-2">
            {needsAttention.length === 0 ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                {m.noIssues}
              </div>
            ) : (
              needsAttention.map((item) => (
                <Link
                  key={`${item.title}-${item.detail}`}
                  href={item.href}
                  className={`rounded-2xl border p-4 ${attentionToneClass(item.tone)}`}
                >
                  <div className="font-black text-white">{item.title}</div>
                  <p className="mt-1 text-sm leading-6 text-zinc-300">{item.detail}</p>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
          <h2 className="text-xl font-black text-white">{m.environmentTitle}</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            {missingEnv.length === 0
              ? m.environmentAllConfigured(envChecks.length)
              : m.environmentMissing(missingEnv.length, envChecks.length)}
          </p>
          {/*
            "Not configured" and "blocking" were the same sentence here, and
            they are not the same fact: on 2026-09-14 seven rows were reported
            missing and two of them were optional notification channels. The
            count that matters is stated separately, and the grouping that
            explains it is one link away.
          */}
          {missingEnv.length > 0 ? (
            <p className="mt-1 text-sm leading-6 text-zinc-300">
              {blockingEnvCount === 0
                ? m.environmentNoneBlocking
                : m.environmentBlocking(blockingEnvCount)}{" "}
              <Link
                href="/admin/overview?tab=health#admin-health-environment"
                className="font-bold text-blue-300 underline-offset-2 hover:underline"
              >
                {m.explainScore}
              </Link>
            </p>
          ) : null}
          <div className="mt-4 grid gap-2">
            {missingEnv.map((check) => (
              // `min-w-0` on the card, not only on the text beside the icon.
              //
              // Not covered by a test. A page-width assertion cannot hold here
              // -- /admin/overview overflows for reasons this section does not
              // control (419 against 412 on CI, 367 against 320 on develop from
              // the quick access panel) -- and a card-width assertion does not
              // fail when the bug is reintroduced, because the card is sized by
              // the page rather than by its own content. The measurement is in
              // the commit: document 457 before, 412 after, at 412px.
              // A grid item's automatic minimum size is its min-content, and a
              // `truncate` descendant still contributes its full nowrap width
              // to that -- `overflow: hidden` exempts the item itself, not an
              // element inside it. So the longest variable name set the track's
              // width and pushed the whole page into horizontal overflow, which
              // on a 412px viewport is enough to carry a dialog's controls off
              // the screen.
              <div
                key={check.name}
                className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-amber-100">
                    {check.name}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-amber-100/70">
                    {check.description}
                  </p>
                </div>
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
              </div>
            ))}
          </div>
          {/*
            Configured variables are collapsed rather than dropped: an operator
            checking a specific name still finds it, and the default view stays
            about what is missing.
          */}
          {/*
            The panel reads `process.env`, which is fixed at process start, so
            "not configured" cannot be told apart from "configured after this
            process started" -- and the refresh control cannot close the gap,
            because it re-renders inside this same process. Stating the start
            time is the smallest thing that makes the difference visible.
          */}
          <p
            className="mt-3 text-xs leading-5 text-zinc-500"
            data-testid="admin-overview-process-window"
          >
            {m.processStartedNote(processStartedAt)}
          </p>
          <details className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50">
            <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-zinc-300">
              {m.showAllVariables(envChecks.length)}
            </summary>
            <div className="grid gap-2 px-3 pb-3">
              {envChecks.map((check) => (
                <div
                  key={check.name}
                  className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-zinc-200">
                      {check.name}
                    </p>
                    <p className="mt-0.5 text-xs leading-4 text-zinc-400">
                      {check.description}
                    </p>
                  </div>
                  {check.configured ? (
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300"
                      aria-label={m.configured}
                    />
                  ) : (
                    <XCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                      aria-label={m.notConfigured}
                    />
                  )}
                </div>
              ))}
            </div>
          </details>
        </section>
      </div>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-black text-white">{m.latestChangesTitle}</h2>
          <Link
            href="/admin/audit"
            className="shrink-0 text-xs font-bold text-blue-300 hover:text-blue-200"
          >
            {m.openAuditLog}
          </Link>
        </div>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          {m.latestChangesDescription(recentActivityLimit)}
        </p>
        <div className="mt-4 grid gap-2">
          {recentActivity.length === 0 ? (
            <p className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
              {m.noActivity}
            </p>
          ) : (
            recentActivity.map((entry) => (
              <div
                key={entry.id}
                className="grid gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-zinc-100">
                    {entry.summary}
                  </p>
                  <p className="mt-1 truncate text-xs text-zinc-400">
                    {entry.actorEmail || m.fallbackActor} · {entry.action}
                  </p>
                </div>
                <span className="text-xs text-zinc-500">
                  {new Date(entry.createdAt).toISOString().replace("T", " ").slice(0, 16)}{" "}
                  UTC
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
