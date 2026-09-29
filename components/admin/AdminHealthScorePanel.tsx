import Link from "next/link";
import { AlertTriangle, ArrowLeft, HelpCircle } from "lucide-react";
import {
  ADMIN_HEALTH_WEIGHTS,
  type AdminHealthBreakdown,
  type AdminHealthFactor,
} from "@/lib/adminHealthScore";
import {
  groupEnvChecksBySeverity,
  type AdminEnvCheck,
} from "@/lib/adminEnvironmentChecks";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";

/**
 * Why the health score is the number it is, and what to do about each part.
 *
 * The score is one figure built from six counts and twenty-nine environment
 * rows, and until this page existed there was nowhere to see any of that. An
 * operator reading "20" could not tell whether one provider was down or six
 * optional variables were unset -- which are the same twenty points and
 * entirely different mornings.
 *
 * Three things this page refuses to do, because each of them is a way of
 * telling an operator something untrue:
 *
 * - **An unreadable input is not a zero.** A failed count renders as "could
 *   not be read" and deducts nothing, and the header says the score is a
 *   ceiling. Reporting the score as if the read had succeeded would be a
 *   confident number built on a missing one.
 * - **A floored score says so.** Once deductions pass 100 the number stops
 *   moving, so a new outage changes nothing. That is precisely when an
 *   operator would most trust a falling number, so the page says the number
 *   has stopped being a signal and to read the lines instead.
 * - **Nothing that is not counted is hidden.** Conditional, recommended and
 *   optional variables are all listed, priced at zero, with the reason. A
 *   panel that quietly dropped them would be as misleading as the old one that
 *   charged ten points for a Discord webhook nobody wanted.
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

const cardTone = (line: AdminHealthBreakdown["lines"][number]) =>
  !line.known
    ? "border-zinc-700 bg-zinc-900"
    : line.deduction === 0
      ? "border-zinc-800 bg-zinc-900/40"
      : line.deduction >= 18
        ? "border-red-500/30 bg-red-500/10"
        : "border-amber-500/25 bg-amber-500/10";

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
      <h3
        className={`text-sm font-bold ${
          tone === "required" ? "text-amber-200" : "text-zinc-200"
        }`}
      >
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
                tone === "required"
                  ? "border-amber-500/20 bg-amber-500/10"
                  : "border-zinc-800 bg-zinc-900/60"
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
                  <span className="font-bold text-zinc-400">
                    {conditionLabel}:
                  </span>{" "}
                  {check.condition}
                </p>
              ) : null}
              <p className="mt-1 text-xs leading-5 text-zinc-400">
                {check.description}
              </p>
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
  /** ISO instant, already trimmed to the minute by the page. */
  processStartedAt: string;
}) {
  const { health: m, summary } = await getAdminMessages(adminOverviewMessages);
  const groups = groupEnvChecksBySeverity(envChecks);
  const deducting = breakdown.lines.filter((line) => line.deduction > 0);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
        <Link
          href="/admin/overview?tab=summary"
          className="inline-flex items-center gap-2 text-xs font-bold text-blue-300 hover:text-blue-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {m.backToSummary}
        </Link>
        <h2 className="mt-3 text-xl font-black text-white">{m.title}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.subtitle}
        </p>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="text-2xl font-black text-white">
            {m.score(breakdown.score)}
          </p>
          <p className="font-mono text-sm text-zinc-400">
            {m.formula(breakdown.totalDeduction)}
          </p>
        </div>

        {breakdown.incomplete ? (
          <div
            className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
            data-testid="admin-health-incomplete"
          >
            <p className="flex items-center gap-2 text-sm font-bold text-amber-100">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {m.incompleteTitle}
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-100/80">
              {m.incomplete(
                breakdown.unknownFactors
                  .map((factor) => m.factors[factor])
                  .join(", ")
              )}
            </p>
          </div>
        ) : null}

        {breakdown.floored ? (
          <div
            className="mt-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4"
            data-testid="admin-health-floored"
          >
            <p className="flex items-center gap-2 text-sm font-bold text-red-100">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {m.flooredTitle}
            </p>
            <p className="mt-1 text-xs leading-5 text-red-100/80">
              {m.floored(breakdown.totalDeduction)}
            </p>
          </div>
        ) : null}

        {deducting.length === 0 && !breakdown.incomplete ? (
          <p className="mt-4 text-sm leading-6 text-emerald-200">{m.perfect}</p>
        ) : null}
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h2 className="text-xl font-black text-white">{m.tableCaption}</h2>
        <ul className="mt-4 grid gap-2">
          {breakdown.lines.map((line) => (
            <li
              key={line.factor}
              className={`min-w-0 rounded-2xl border p-4 ${cardTone(line)}`}
              data-testid={`admin-health-line-${line.factor}`}
            >
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="min-w-0 text-sm font-bold text-white">
                  {m.factors[line.factor]}
                </p>
                <p className="font-mono text-xs text-zinc-300">
                  {line.count === null
                    ? m.unknownCount
                    : `${line.count} × ${line.weight} = −${line.deduction}`}
                </p>
              </div>
              <p className="mt-1 text-xs leading-5 text-zinc-300">
                {line.deduction > 0 || !line.known ? (
                  <Link
                    href={FACTOR_HREF[line.factor]}
                    className="font-bold text-blue-300 underline-offset-2 hover:underline"
                  >
                    {m.actions[line.factor]}
                  </Link>
                ) : (
                  <span className="text-zinc-500">{m.noDeduction}</span>
                )}
              </p>
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-zinc-200">
            <HelpCircle className="h-4 w-4 shrink-0" aria-hidden />
            {m.notCountedTitle}
          </p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">{m.notCounted}</p>
        </div>
      </section>

      <section
        id="admin-health-environment"
        className="scroll-mt-6 rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
      >
        <h2 className="text-xl font-black text-white">{m.environmentTitle}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          {groups.required.length === 0
            ? summary.environmentNoneBlocking
            : summary.environmentBlocking(groups.required.length)}
        </p>
        <div className="mt-4 grid gap-3">
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

        <div
          className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
          data-testid="admin-health-process-window"
        >
          <p className="text-sm font-bold text-zinc-200">{m.processTitle}</p>
          <p className="mt-1 text-xs leading-5 text-zinc-300">
            {m.processStarted(processStartedAt)}
          </p>
          <p className="mt-1 text-xs leading-5 text-zinc-400">
            {m.processCaveat}
          </p>
        </div>
      </section>
    </div>
  );
}
