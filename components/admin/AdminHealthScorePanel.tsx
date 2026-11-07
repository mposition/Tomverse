import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check } from "lucide-react";
import { AdminGauge } from "@/components/admin/ui/AdminCharts";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import {
  ADMIN_HEALTH_WEIGHTS,
  type AdminHealthBreakdown,
  type AdminHealthFactor,
  type AdminHealthLine,
} from "@/lib/adminHealthScore";
import { groupEnvChecksBySeverity, type AdminEnvCheck } from "@/lib/adminEnvironmentChecks";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";
import type { AdminTone } from "@/lib/adminUiCore";

/**
 * Why the health score is the number it is, and what to do about each part.
 *
 * The rules are unchanged from the arithmetic this page has always shown
 * (`lib/adminHealthScore.ts`); this is how it is drawn. Three things it still
 * refuses to do, because each is a way of telling an operator something
 * untrue:
 *
 * - **An unreadable input is not a zero.** It reads "Unread", deducts nothing,
 *   and the header says the score is a ceiling.
 * - **A floored score says so.** Once deductions pass 100 the number stops
 *   moving, so the page says to read the lines instead of the number.
 * - **Nothing that is not counted is hidden.** Conditional, recommended and
 *   optional variables are all listed, priced at zero, with the reason.
 *
 * There is no 30-day line: the score is computed on demand and its history is
 * not stored anywhere, so the page does not draw one.
 */

const FACTOR_HREF: Record<AdminHealthFactor, string> = {
  outage: "/admin/providers",
  limited: "/admin/providers",
  // Its own section, further down this page: the fix is reading which
  // variables are blocking, and that list is already here.
  blockingEnv: "#admin-health-environment",
  alertFailure: "/admin/alerts",
  pendingRefund: "/admin/refunds",
  openFeedback: "/admin/support?tab=feedback",
};

const lineTone = (line: AdminHealthLine): AdminTone =>
  !line.known ? "unknown" : line.deduction === 0 ? "ok" : line.deduction >= 18 ? "bad" : "warn";

function EnvGroup({
  title,
  detail,
  checks,
  emptyLabel,
  conditionLabel,
  tone,
}: {
  title: string;
  detail: string;
  checks: AdminEnvCheck[];
  emptyLabel: string;
  conditionLabel: string;
  tone: "required" | "muted";
}) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
      <h3 className={`text-sm font-bold ${tone === "required" ? "text-amber-200" : "text-zinc-200"}`}>
        {title} <span className="text-zinc-500">({checks.length})</span>
      </h3>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{detail}</p>
      {checks.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-500">{emptyLabel}</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {checks.map((check) => (
            <li
              key={check.name}
              className={`min-w-0 rounded-xl border px-3 py-2 ${
                tone === "required" ? "border-amber-500/20 bg-amber-500/10" : "border-zinc-800 bg-zinc-900/60"
              }`}
            >
              <p
                className={`truncate font-mono text-xs font-bold ${
                  tone === "required" ? "text-amber-100" : "text-zinc-200"
                }`}
              >
                {check.name}
              </p>
              {check.condition ? (
                <p className="mt-1 text-xs leading-5 text-zinc-300">
                  <span className="font-bold text-zinc-400">{conditionLabel}:</span> {check.condition}
                </p>
              ) : null}
              <p className="mt-1 text-xs leading-5 text-zinc-400">{check.description}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export async function AdminHealthScorePanel({
  breakdown,
  envChecks,
  processStartedAt,
}: {
  breakdown: AdminHealthBreakdown;
  envChecks: AdminEnvCheck[];
  /** The start time of the process answering this request, already in AEST. */
  processStartedAt: string;
}) {
  const [home, { health: m, summary }] = await Promise.all([
    getAdminMessages(adminHomeMessages),
    getAdminMessages(adminOverviewMessages),
  ]);
  const h = home.health;
  const groups = groupEnvChecksBySeverity(envChecks);
  const deducting = breakdown.lines.filter((line) => line.deduction > 0);
  const outage = breakdown.lines.find((line) => line.factor === "outage");
  const verdict =
    breakdown.score >= 90
      ? h.verdict.great
      : breakdown.score >= 75
        ? h.verdict.fine
        : breakdown.score >= 50
          ? h.verdict.watch
          : h.verdict.bad;
  const costLine =
    deducting.length === 0
      ? h.costNone
      : outage && outage.deduction > 0
        ? h.costOutage(deducting.length, breakdown.totalDeduction)
        : h.cost(deducting.length, breakdown.totalDeduction);
  // The fastest ways up: the dearest deductions first, since fixing one gives
  // back exactly what it cost.
  const fastest = [...deducting].sort((left, right) => right.deduction - left.deduction).slice(0, 3);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Link
        href="/admin/overview?tab=summary"
        className="inline-flex items-center gap-2 self-start text-xs font-bold text-blue-300 hover:text-blue-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {m.backToSummary}
      </Link>

      <div className="grid gap-4 xl:grid-cols-2">
        <AdminTile title={m.title} description={m.subtitle} data-testid="admin-health-gauge">
          <div className="flex flex-col items-center gap-4 pt-2">
            <AdminGauge score={breakdown.score} size={240} stroke={20} label={h.gaugeLabel(breakdown.score)}>
              <span className="text-5xl font-black tabular-nums text-white">{breakdown.score}</span>
              <span className="text-xs text-zinc-400">{h.outOf}</span>
            </AdminGauge>
            <div className="text-center">
              <p className="text-lg font-black text-white">{verdict}</p>
              <p className="mt-1 text-sm leading-6 text-zinc-400">{costLine}</p>
              <p className="mt-1 font-mono text-xs text-zinc-500">{m.formula(breakdown.totalDeduction)}</p>
            </div>
          </div>

          {breakdown.incomplete ? (
            <div
              className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
              data-testid="admin-health-incomplete"
            >
              <p className="flex items-center gap-2 text-sm font-bold text-amber-100">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                {m.incompleteTitle}
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-100/80">
                {m.incomplete(breakdown.unknownFactors.map((factor) => m.factors[factor]).join(", "))}
              </p>
            </div>
          ) : null}

          {breakdown.floored ? (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4" data-testid="admin-health-floored">
              <p className="flex items-center gap-2 text-sm font-bold text-red-100">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                {m.flooredTitle}
              </p>
              <p className="mt-1 text-xs leading-5 text-red-100/80">{m.floored(breakdown.totalDeduction)}</p>
            </div>
          ) : null}
          <p className="text-xs text-zinc-500">{h.trendNote}</p>
        </AdminTile>

        <AdminTile title={h.fastestTitle} description={h.fastestDescription} data-testid="admin-health-fastest">
          {fastest.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-zinc-700 p-4 text-sm text-zinc-300">
              {breakdown.incomplete ? h.fastestUnread : h.fastestNone}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {fastest.map((line) => (
                <li key={line.factor}>
                  <Link
                    href={FACTOR_HREF[line.factor]}
                    className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-3 hover:border-zinc-700"
                  >
                    <span className="inline-flex h-10 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-sm font-black text-emerald-300">
                      {h.gain(line.deduction)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-zinc-100">{m.factors[line.factor]}</span>
                      <span className="block text-xs leading-5 text-zinc-400">{m.actions[line.factor]}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AdminTile>
      </div>

      <AdminTile title={h.reasonsTitle} description={h.reasonsDescription}>
        {deducting.length === 0 && !breakdown.incomplete ? (
          <p className="text-sm leading-6 text-emerald-200">{m.perfect}</p>
        ) : null}
        <ul className="flex flex-col">
          {breakdown.lines.map((line) => (
            <li
              key={line.factor}
              data-testid={`admin-health-line-${line.factor}`}
              className="flex min-w-0 flex-wrap items-center gap-3 border-t border-zinc-800 py-3"
            >
              <span
                aria-hidden
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                  line.deduction > 0 || !line.known
                    ? "bg-amber-500/15 text-amber-300"
                    : "bg-emerald-500/15 text-emerald-300"
                }`}
              >
                {line.deduction > 0 || !line.known ? <AlertTriangle className="h-5 w-5" /> : <Check className="h-5 w-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-zinc-100">{m.factors[line.factor]}</span>
                <span className="block font-mono text-xs text-zinc-500">
                  {line.count === null ? m.unknownCount : `${line.count} × ${line.weight} = −${line.deduction}`}
                </span>
              </span>
              <AdminStatusChip tone={lineTone(line)}>
                {!line.known ? h.unreadPoints : line.deduction > 0 ? h.points(line.deduction) : h.zeroPoints}
              </AdminStatusChip>
              {line.deduction > 0 || !line.known ? (
                <Link
                  href={FACTOR_HREF[line.factor]}
                  className="inline-flex min-h-9 items-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
                >
                  {h.open[line.factor]}
                </Link>
              ) : (
                <span className="w-[5.5rem] text-right text-xs text-zinc-500">{h.nothingToDo}</span>
              )}
            </li>
          ))}
        </ul>
      </AdminTile>

      <AdminTile title={h.howTitle} description={h.howSummary}>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {breakdown.lines.map((line) => (
            <li
              key={line.factor}
              className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-zinc-300">{m.factors[line.factor]}</span>
              <span className="shrink-0 font-bold tabular-nums text-zinc-100">
                {h.points(ADMIN_HEALTH_WEIGHTS[line.factor])}
              </span>
            </li>
          ))}
        </ul>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4">
          <p className="text-sm font-bold text-zinc-200">{m.notCountedTitle}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{m.notCounted}</p>
        </div>
      </AdminTile>

      <AdminTile
        id="admin-health-environment"
        title={m.environmentTitle}
        description={
          groups.required.length === 0
            ? summary.environmentNoneBlocking
            : summary.environmentBlocking(groups.required.length)
        }
        className="scroll-mt-6"
      >
        <div className="grid gap-3">
          <EnvGroup
            title={m.groupRequired}
            detail={m.groupRequiredDetail(ADMIN_HEALTH_WEIGHTS.blockingEnv)}
            checks={groups.required}
            emptyLabel={m.groupEmpty}
            conditionLabel={m.conditionLabel}
            tone="required"
          />
          <EnvGroup
            title={m.groupConditional}
            detail={m.groupConditionalDetail}
            checks={groups.conditional}
            emptyLabel={m.groupEmpty}
            conditionLabel={m.conditionLabel}
            tone="muted"
          />
          <EnvGroup
            title={m.groupRecommended}
            detail={m.groupRecommendedDetail}
            checks={groups.recommended}
            emptyLabel={m.groupEmpty}
            conditionLabel={m.conditionLabel}
            tone="muted"
          />
          <EnvGroup
            title={m.groupOptional}
            detail={m.groupOptionalDetail}
            checks={groups.optional}
            emptyLabel={m.groupEmpty}
            conditionLabel={m.conditionLabel}
            tone="muted"
          />
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4" data-testid="admin-health-process-window">
          <p className="text-sm font-bold text-zinc-200">{m.processTitle}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-300">{m.processStarted(processStartedAt)}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{m.processCaveat}</p>
        </div>
      </AdminTile>
    </div>
  );
}
