"use client";

import Link from "next/link";
import { useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminAutoFixReviewMessages } from "@/lib/adminMessages/autoFixReview";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { useSupportInboxRefresh } from "@/components/admin/useSupportInboxRefresh";

/**
 * The Support page's auto-fix review section
 * (docs/policy/trace-feedback-automation.md §9.3).
 *
 * One card per case: the problem the verified trace recorded, the cause and
 * fix the run proposed, the files it changed with its Red→Green proof, and
 * where the fix is on its way to production -- every step of which the server
 * observed itself. The only control is the owner's approval, bound to the PR
 * head shown on the card. Merging is not a control here: both PRs are merged
 * by a person in GitHub, and the card links to them.
 */

export type AutoFixReviewRow = {
  id: string;
  feedbackId: string;
  state: string;
  errorCode: string | null;
  routeClass: string | null;
  release: string | null;
  provider: string | null;
  modelId: string | null;
  occurredAt: string | null;
  sentryTitle: string | null;
  rootCause: string | null;
  fixSummary: string | null;
  testSummary: string | null;
  changedPaths: string[];
  proofTestPath: string | null;
  fixPrUrl: string | null;
  fixHeadSha: string | null;
  approvedAt: string | null;
  stagingVerifiedAt: string | null;
  productionPrUrl: string | null;
  productionVerifiedAt: string | null;
  promotionObservedAt: string | null;
  promotionObservation: string | null;
  terminalReason: string | null;
  updatedAt: string;
};

type Props = {
  rows: AutoFixReviewRow[];
  rowLimit: number;
  /** Server-resolved: what must be configured before approval can work. */
  configurationProblems: string[];
};

const dateLabel = (value: string | null) =>
  value ? new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC" : null;

const stateTone = (state: string) => {
  if (state === "promotion_failed") return "border-red-500/40 bg-red-500/10 text-red-100";
  if (state === "production_verified") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (state === "pr_open") return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  return "border-blue-500/30 bg-blue-500/10 text-blue-100";
};

export function AutoFixReviewPanel({ rows, rowLimit, configurationProblems }: Props) {
  const m = useAdminMessages(adminAutoFixReviewMessages);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reauthCaseId, setReauthCaseId] = useState<string | null>(null);
  const refresh = useSupportInboxRefresh({ paused: Boolean(busyId) });
  const approvalAvailable = configurationProblems.length === 0;

  const approve = async (row: AutoFixReviewRow) => {
    if (busyId || !row.fixHeadSha) return;
    setBusyId(row.id);
    setReauthCaseId(null);
    try {
      const response = await fetch(`/api/admin/feedback-autofix/${row.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headSha: row.fixHeadSha }),
      });
      const data = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;
      if (response.ok) {
        dispatchAppToast(m.toast.approved, "success");
      } else if (data?.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setReauthCaseId(row.id);
      } else {
        dispatchAppToast(
          (data?.code && m.toast.refused[data.code]) || m.toast.failed,
          "error"
        );
      }
    } catch {
      dispatchAppToast(m.toast.failed, "error");
    } finally {
      setBusyId(null);
      // Approved or refused, the server's view of the case is what the
      // screen and the sidebar badge must show next.
      refresh();
    }
  };

  return (
    <section
      id="fixes"
      data-testid="autofix-review-panel"
      className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
    >
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">{m.eyebrow}</p>
      <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        {m.description}
        {m.rowLimit(rowLimit)}
      </p>
      {!approvalAvailable ? (
        <p
          data-testid="autofix-review-not-configured"
          className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-bold text-amber-100"
        >
          {m.notConfigured(configurationProblems.join(", "))}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-5 text-sm text-zinc-400">{m.empty}</p>
      ) : (
        <ul className="mt-5 grid gap-4">
          {rows.map((row) => {
            const busy = busyId === row.id;
            return (
              <li
                key={row.id}
                data-testid="autofix-review-case"
                data-state={row.state}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold ${stateTone(row.state)}`}
                  >
                    {row.state === "promotion_failed" ? (
                      <ShieldAlert className="h-3.5 w-3.5" />
                    ) : row.state === "production_verified" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <Wrench className="h-3.5 w-3.5" />
                    )}
                    {m.states[row.state] ?? row.state}
                  </span>
                  <span className="font-mono text-xs text-zinc-500">{row.id}</span>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div data-testid="autofix-review-problem">
                    <h3 className="text-sm font-bold text-zinc-100">{m.problem.heading}</h3>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-300">
                      <dt className="text-zinc-500">{m.problem.errorCode}</dt>
                      <dd className="font-mono">{row.errorCode ?? "-"}</dd>
                      <dt className="text-zinc-500">{m.problem.route}</dt>
                      <dd className="font-mono">{row.routeClass ?? "-"}</dd>
                      <dt className="text-zinc-500">{m.problem.release}</dt>
                      <dd className="font-mono">{row.release ?? "-"}</dd>
                      <dt className="text-zinc-500">{m.problem.model}</dt>
                      <dd className="font-mono">
                        {[row.provider, row.modelId].filter(Boolean).join(" / ") || "-"}
                      </dd>
                      <dt className="text-zinc-500">{m.problem.occurredAt}</dt>
                      <dd>{dateLabel(row.occurredAt) ?? "-"}</dd>
                      {row.sentryTitle ? (
                        <>
                          <dt className="text-zinc-500">{m.problem.sentry}</dt>
                          <dd>{row.sentryTitle}</dd>
                        </>
                      ) : null}
                    </dl>
                  </div>

                  <div data-testid="autofix-review-solution">
                    <h3 className="text-sm font-bold text-zinc-100">{m.solution.heading}</h3>
                    {row.rootCause || row.fixSummary ? (
                      <dl className="mt-2 grid gap-2 text-xs leading-5 text-zinc-300">
                        <div>
                          <dt className="text-zinc-500">{m.solution.rootCause}</dt>
                          <dd className="whitespace-pre-wrap">{row.rootCause ?? "-"}</dd>
                        </div>
                        <div>
                          <dt className="text-zinc-500">{m.solution.fix}</dt>
                          <dd className="whitespace-pre-wrap">{row.fixSummary ?? "-"}</dd>
                        </div>
                        {row.testSummary ? (
                          <div>
                            <dt className="text-zinc-500">{m.solution.test}</dt>
                            <dd className="whitespace-pre-wrap">{row.testSummary}</dd>
                          </div>
                        ) : null}
                      </dl>
                    ) : (
                      <p className="mt-2 text-xs text-zinc-400">{m.solution.noReport}</p>
                    )}
                    {row.changedPaths.length ? (
                      <div className="mt-3 text-xs text-zinc-300">
                        <p className="text-zinc-500">{m.solution.changedFiles}</p>
                        <ul className="mt-1 font-mono">
                          {row.changedPaths.map((path) => (
                            <li key={path}>{path}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {row.proofTestPath ? (
                      <p className="mt-2 text-xs text-zinc-400">{m.solution.proof(row.proofTestPath)}</p>
                    ) : null}
                  </div>
                </div>

                <div data-testid="autofix-review-progress" className="mt-4 border-t border-zinc-800 pt-3">
                  <h3 className="text-sm font-bold text-zinc-100">{m.progress.heading}</h3>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-300">
                    <dt className="text-zinc-500">{m.progress.approved}</dt>
                    <dd>{dateLabel(row.approvedAt) ?? m.progress.notYet}</dd>
                    <dt className="text-zinc-500">{m.progress.staging}</dt>
                    <dd>{dateLabel(row.stagingVerifiedAt) ?? m.progress.notYet}</dd>
                    <dt className="text-zinc-500">{m.progress.production}</dt>
                    <dd>{dateLabel(row.productionVerifiedAt) ?? m.progress.notYet}</dd>
                    {row.promotionObservation ? (
                      <>
                        <dt className="text-zinc-500">{m.progress.observation}</dt>
                        <dd data-testid="autofix-review-observation">
                          {row.promotionObservation}
                          {row.promotionObservedAt ? ` (${dateLabel(row.promotionObservedAt)})` : ""}
                        </dd>
                      </>
                    ) : null}
                    {row.state === "promotion_failed" && row.terminalReason ? (
                      <>
                        <dt className="text-zinc-500">{m.failureReason}</dt>
                        <dd data-testid="autofix-review-failure">{row.terminalReason}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {row.state === "pr_open" ? (
                    <button
                      type="button"
                      onClick={() => approve(row)}
                      disabled={!approvalAvailable || Boolean(busyId) || !row.fixHeadSha}
                      data-testid="autofix-review-approve"
                      className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      {busy ? m.actions.approving : m.actions.approve}
                    </button>
                  ) : null}
                  {row.fixPrUrl ? (
                    <a
                      href={row.fixPrUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900"
                    >
                      <GitPullRequest className="h-4 w-4" />
                      {m.actions.openPr}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                  {row.productionPrUrl ? (
                    <a
                      href={row.productionPrUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900"
                    >
                      <GitPullRequest className="h-4 w-4" />
                      {m.actions.openMainPr}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                  {row.state === "production_verified" ? (
                    <Link
                      href={`/admin/support?tab=feedback&q=${encodeURIComponent(row.feedbackId)}`}
                      data-testid="autofix-review-open-report"
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-700 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-600"
                    >
                      {m.actions.openReport}
                    </Link>
                  ) : null}
                </div>
                {row.state === "pr_open" && row.fixHeadSha ? (
                  <p className="mt-2 text-xs text-zinc-500">
                    {m.actions.approveHint(row.fixHeadSha.slice(0, 12))}
                  </p>
                ) : null}
                {reauthCaseId === row.id ? (
                  <div
                    role="alert"
                    aria-live="assertive"
                    data-testid="autofix-review-reauthentication"
                    className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs font-bold text-red-100"
                  >
                    <p>{m.actions.reauthenticationRequired}</p>
                    <Link
                      href={adminRecentAuthenticationHref("/admin/support?tab=fixes")}
                      data-testid="autofix-review-reauthenticate-link"
                      className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-red-400/50 px-2.5 py-1.5 font-bold text-red-50 underline-offset-4 transition hover:bg-red-500/20 hover:underline"
                    >
                      {m.actions.reauthenticate}
                    </Link>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
