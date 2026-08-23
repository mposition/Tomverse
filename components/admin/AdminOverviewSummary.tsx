import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { AdminSnapshotActions } from "@/components/admin/AdminSnapshotActions";
import type { AdminEnvCheck } from "@/lib/adminEnvironmentChecks";

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
  value: string;
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

function KpiCard({ label, value, detail, tone }: Kpi) {
  return (
    <div className={`rounded-2xl border p-4 ${toneClass(tone)}`}>
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black text-white">{value}</p>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{detail}</p>
    </div>
  );
}

export function AdminOverviewSummary({
  generatedAt,
  adminRole,
  healthScore,
  operationalKpis,
  commercialKpis,
  needsAttention,
  envChecks,
  recentActivity,
  recentActivityLimit,
  snapshotReport,
}: {
  generatedAt: string;
  adminRole: string;
  healthScore: number;
  operationalKpis: Kpi[];
  commercialKpis: Kpi[];
  needsAttention: AttentionItem[];
  envChecks: AdminEnvCheck[];
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
  const missingEnv = envChecks.filter((check) => !check.configured);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-black text-white">Operations snapshot</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              Generated {generatedAt} UTC · signed in as {adminRole}.
            </p>
          </div>
          <AdminSnapshotActions report={snapshotReport} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="Health score"
            value={String(healthScore)}
            detail="Readiness out of 100, weighted by outages, queue depth, and missing configuration."
            tone="blue"
          />
          {operationalKpis.map((kpi) => (
            <KpiCard key={kpi.label} {...kpi} />
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h2 className="text-xl font-black text-white">
          Revenue and retention snapshot
        </h2>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          Paid conversion, active plan mix, promotions, refunds, and subscriptions
          scheduled to cancel.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {commercialKpis.map((kpi) => (
            <KpiCard key={kpi.label} {...kpi} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-black text-white">Launch readiness queue</h2>
            <Link
              href="/admin/work-queue"
              className="text-xs font-bold text-blue-300 hover:text-blue-200"
            >
              Open work queue
            </Link>
          </div>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            The highest-signal items to review before they become user-facing
            incidents. Capped at six; the work queue lists every open item.
          </p>
          <div className="mt-5 grid gap-2">
            {needsAttention.length === 0 ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                No immediate operational issues detected.
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
          <h2 className="text-xl font-black text-white">Environment health</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">
            {missingEnv.length === 0
              ? `All ${envChecks.length} tracked variables are configured.`
              : `${missingEnv.length} of ${envChecks.length} tracked variables are not configured.`}
          </p>
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
          <details className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50">
            <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-zinc-300">
              Show all {envChecks.length} tracked variables
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
                      aria-label="Configured"
                    />
                  ) : (
                    <XCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
                      aria-label="Not configured"
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
          <h2 className="text-xl font-black text-white">
            Latest administrator changes
          </h2>
          <Link
            href="/admin/audit"
            className="shrink-0 text-xs font-bold text-blue-300 hover:text-blue-200"
          >
            Open audit log
          </Link>
        </div>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          The {recentActivityLimit} most recent audit entries, newest first. Not a
          count of all administrator activity.
        </p>
        <div className="mt-4 grid gap-2">
          {recentActivity.length === 0 ? (
            <p className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
              No administrator activity has been recorded yet.
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
                    {entry.actorEmail || "Administrator"} · {entry.action}
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
