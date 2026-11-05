"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxIdeaClosePanel } from "@/components/admin/AmuxIdeaClosePanel";
import { AmuxIdeaName, laneLine } from "@/components/admin/AmuxIdeaProgressPanel";
import { AmuxSessionAnalysisStopPanel } from "@/components/admin/AmuxSessionAnalysisStopPanel";
import { AmuxSessionIdeaCancelPanel } from "@/components/admin/AmuxSessionIdeaCancelPanel";
import { AmuxReadManifestPathsPanel } from "@/components/admin/AmuxReadManifestPathsPanel";
import { AmuxSessionReviewPanel } from "@/components/admin/AmuxSessionReviewPanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { amuxIdeaHasUnsavedDraft } from "@/lib/amux/ideaDraftGuard";
import { AMUX_IDEA_PROGRESS_STAGES, amuxIdeaProgressStep, amuxIdeaStatusNotice,
  type AmuxIdeaStatusNoticeKind } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const REPOSITORY_URL = "https://github.com/mposition/Tomverse";
/** The steps a person takes; every other step runs on its own. */
const HUMAN_STEPS = new Set(["execution_approval", "plan_approval", "review"]);
const EXCLUSION_REASONS = ["secretPath", "secretContent", "nonRegular",
  "unscannableContent"] as const;
const LINK = "inline-flex min-h-11 items-center font-medium underline text-blue-200";
const SCREENS = {
  cards: "/admin/amux-execution?tab=cards",
  safety: "/admin/amux-settings?tab=safety",
  recovery: "/admin/amux-backlog?tab=recovery",
  promotion: "/admin/amux-promotion",
  approval: "#amux-v4-frontier-models-heading",
} as const;
/** The existing screens each state can act on; the panels below this card carry the rest. */
const NOTICE_ACTIONS: Partial<Record<AmuxIdeaStatusNoticeKind, Array<keyof typeof SCREENS>>> = {
  attention: ["safety", "recovery"],
  analysis_waiting: ["recovery"],
  execution_running: ["cards"],
  execution_waiting: ["cards", "promotion"],
  execution_blocked: ["safety"],
  execution_approval: ["approval"],
  continuation: ["approval"],
};

/**
 * The top of one idea's detail (approved backlog redesign, B3): where the idea
 * is on the six steps, which of them are a person's, what is actually happening
 * and what the owner can do about it, and its Tasks with their PRs. Everything here is read from the progress snapshot; there is no action
 * besides opening GitHub, reading its own CLI manifest, cancelling a queued v19 session idea,
 * stopping its in-flight analysis and closing an idea that waits for the owner, because
 * other human steps have their own panels below and merge is observed here.
 */
export function AmuxIdeaDetailSummary({ row }: { row: AmuxIdeaProgressRow }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const step = amuxIdeaProgressStep(row.stage);
  const notice = amuxIdeaStatusNotice(row);
  const blockedTasks = row.taskRows.filter((task) => task.status === "blocked" && !task.merged);
  return (
    <section className="space-y-4 rounded-xl border p-4 text-sm border-zinc-800 bg-zinc-900/60"
      aria-labelledby="amux-idea-detail-heading" data-testid="amux-idea-detail" data-stage={row.stage}
      data-activity={row.activity ?? undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="amux-idea-detail-heading" className="text-lg font-semibold text-zinc-100">
          <AmuxIdeaName row={row} untitled={m.untitled} />
        </h2>
        <Link href="/admin/amux-backlog?tab=ideas" onClick={(event) => {
          // A new draft started from this idea is never stored; ask before leaving it.
          if (amuxIdeaHasUnsavedDraft() && !window.confirm(m.leaveDraft)) event.preventDefault();
        }} className="min-h-11 content-center text-sm font-medium underline text-blue-200">
          {m.backToList}
        </Link>
      </div>
      {row.attention && !row.lane ? <p role="alert" className="text-red-200">{m.attentionDetail}</p> : null}
      <ol className="grid gap-2 sm:grid-cols-6" aria-label={m.stepsLabel}>
        {AMUX_IDEA_PROGRESS_STAGES.map((stage, index) => {
          const position = index + 1;
          const state = step === null ? "later" : position < step ? "done" : position === step ? "current" : "later";
          return (
            <li key={stage} aria-current={state === "current" ? "step" : undefined}
              className={`rounded-lg border p-2 ${state === "current"
                ? (row.attention || row.activity === "blocked" ? "border-red-400" : HUMAN_STEPS.has(stage) ? "border-amber-400"
                  : row.activity === "waiting" ? "border-zinc-500" : "border-blue-400")
                : state === "done" ? "border-blue-500/30" : "border-zinc-800"}`}>
              <span className="block text-xs text-zinc-400">{position}</span>
              <span className="block font-medium text-zinc-100">{m.stages[stage]}</span>
              <span className="block text-xs text-zinc-400">
                {state === "done" ? m.stepDone : state === "current" && row.activity ? m.activity[row.activity]
                  : HUMAN_STEPS.has(stage) ? m.human : m.automatic}
              </span>
            </li>
          );
        })}
      </ol>
      {row.stage === "cancelled" ? <p>{m.stages.cancelled}</p> : null}
      {notice ? (
        <section aria-label={m.statusNowLabel} data-testid="amux-idea-status-now" data-notice={notice}
          className={notice === "attention" ? "" : `space-y-1 rounded-lg border p-3 ${row.activity === "blocked"
            ? "border-red-500/30 bg-red-500/10" : "border-zinc-800"}`}>
          {notice === "attention" ? null : <>
            <h3 className="font-medium text-zinc-100">{m.notice[notice].title}</h3>
            <p className="text-zinc-300">{m.notice[notice].body}</p>
          </>}
          {row.lane ? <p className="text-xs text-zinc-300" data-testid="amux-idea-detail-lane">{laneLine(row.lane, m)}</p> : null}
          {NOTICE_ACTIONS[notice] ? <p className="flex flex-wrap gap-x-4">
            {NOTICE_ACTIONS[notice].map((action) => <Link key={action} href={SCREENS[action]} className={LINK}>
              {m.actions[action]}</Link>)}
          </p> : null}
        </section>
      ) : null}
      {blockedTasks.length > 0 ? (
        <section aria-labelledby="amux-idea-blocked-heading" data-testid="amux-idea-blocked-tasks" className="space-y-2">
          <h3 id="amux-idea-blocked-heading" className="font-medium text-zinc-100">{m.blockedTitle}</h3>
          <ul className="space-y-2">
            {blockedTasks.map((task) => (
              <li key={task.id} className="space-y-1 rounded-lg border border-red-500/30 p-3" data-testid="amux-idea-blocked-task">
                <p className="font-mono text-xs text-zinc-100">{task.displayKey ?? task.id}</p>
                <p className="text-zinc-200">{m.blockReasonLabel}: {task.blockReason ? m.blockReasons[task.blockReason] : m.blockReasonUnknown}</p>
                {task.escalationId ? null : <p className="text-xs text-zinc-400">{m.blockedNoReview}</p>}
                <p className="flex flex-wrap gap-x-4">
                  {task.escalationId ? <Link className={LINK}
                    href={`/admin/amux-execution?tab=assignment&focusEscalation=${encodeURIComponent(task.escalationId)}`}>
                    {m.blockedOpenReview}</Link> : null}
                  <Link className={LINK} href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(task.id)}`}>
                    {m.blockedOpenCard}</Link>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {row.waitingFor === "session_review" ? (
        <p className="text-amber-200" data-testid="amux-session-review">{m.sessionReviewDetail}</p>
      ) : null}
      {row.waitingFor === "session_review" && row.submissionOrigin === "session" ?
        // Keyed by idea: another idea's question never shows while the next one loads.
        <AmuxSessionReviewPanel key={row.ideaId} ideaId={row.ideaId} /> : null}
      {row.closable ? <AmuxIdeaClosePanel key={row.ideaId} mode="single" ideaIds={[row.ideaId]} /> : null}
      {row.submissionOrigin === "session" ?
        <AmuxSessionIdeaCancelPanel ideaId={row.ideaId} /> : null}
      {row.submissionOrigin === "session" ?
        <AmuxSessionAnalysisStopPanel ideaId={row.ideaId} /> : null}
      {row.submissionOrigin === "session" && row.referencePins === null &&
          row.referencePinsLegacy ? (
        <p className="text-zinc-400">{m.intakePinsLegacy}</p>
      ) : null}
      {row.submissionOrigin === "session" && row.referencePins === null &&
          !row.referencePinsLegacy ? (
        <p role="alert" className="text-red-200">{m.intakePinsUnavailable}</p>
      ) : null}
      {row.submissionOrigin === "session" && row.referencePins && row.referencePins.length > 0 ? (
        <section aria-labelledby="amux-intake-pins-heading" data-testid="amux-intake-pins"
          className="space-y-2 border-t border-zinc-800 pt-3">
          <h3 id="amux-intake-pins-heading" className="font-medium text-zinc-100">
            {m.intakePinsTitle}
          </h3>
          <ol className="space-y-1 text-xs text-zinc-300">
            {row.referencePins.map((pin) => <li key={pin.referenceOrdinal}>
              {m.checkoutReference(pin.referenceOrdinal)}: <code className="break-all text-zinc-100">
                {pin.pinnedCommitSha}</code>
            </li>)}
          </ol>
        </section>
      ) : null}
      {row.checkoutEvidence.length > 0 ? (
        <section aria-labelledby="amux-checkout-evidence-heading" data-testid="amux-checkout-evidence"
          className="space-y-2 border-t border-zinc-800 pt-3">
          <h3 id="amux-checkout-evidence-heading" className="font-medium text-zinc-100">
            {m.checkoutEvidenceTitle}
          </h3>
          <ol className="space-y-2">
            {row.checkoutEvidence.map((evidence) => (
              <li key={evidence.referenceOrdinal} className="rounded-lg border border-zinc-800 p-3">
                <p className="font-medium text-zinc-100">{m.checkoutReference(evidence.referenceOrdinal)}</p>
                <p className="text-xs text-zinc-300">{m.checkoutCommit}: <code className="break-all text-zinc-100">
                  {evidence.pinnedCommitSha}</code></p>
                <p className="text-xs text-zinc-300">{m.checkoutExcluded(evidence.excludedCount)}</p>
                {evidence.excludedCount > 0 ? (
                  <ul className="flex flex-wrap gap-x-4 text-xs text-zinc-400">
                    {EXCLUSION_REASONS.filter((reason) => evidence.excludedReasons[reason] > 0)
                      .map((reason) => <li key={reason}>
                        {m.checkoutReasons[reason]}: {evidence.excludedReasons[reason]}
                      </li>)}
                  </ul>
                ) : null}
                {evidence.readManifests.map((manifest, page) => (
                  <div key={manifest.manifestId}
                    className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-300"
                    data-testid="amux-checkout-read-manifest">
                    {/* A continued analysis keeps the files each page read. */}
                    {evidence.readManifests.length > 1 ? (
                      <p className="font-medium text-zinc-200">{m.checkoutReadPage(page + 1)}</p>
                    ) : null}
                    <p>{m.checkoutReadFiles(manifest.fileCount)}</p>
                    <p>{manifest.bodyPurged ? m.checkoutReadPurged : m.checkoutReadEncrypted}</p>
                    <p>{m.checkoutReadDigest}: <code className="break-all text-zinc-100">
                      {manifest.digest}</code></p>
                    {!manifest.bodyPurged ? (
                      <AmuxReadManifestPathsPanel ideaId={row.ideaId}
                        manifestId={manifest.manifestId}
                        fileCount={manifest.fileCount} />
                    ) : null}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {row.taskRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">{m.tasksCaption}</caption>
            <thead className="text-xs text-zinc-400">
              <tr><th className="py-1 pr-3 font-medium">{m.taskColumn}</th>
                <th className="py-1 pr-3 font-medium">{m.statusColumn}</th>
                <th className="py-1 font-medium">{m.prColumn}</th></tr>
            </thead>
            <tbody>
              {row.taskRows.map((task, index) => (
                <tr key={task.displayKey ?? index} className="border-t border-zinc-800">
                  <td className="py-2 pr-3 font-mono text-xs">{task.displayKey ?? "—"}</td>
                  <td className="py-2 pr-3">{task.merged ? m.taskMerged : m.taskStatuses[task.status] ?? task.status}</td>
                  <td className="py-2">
                    {task.reviewPrNumber !== null ? (
                      <a href={`${REPOSITORY_URL}/pull/${task.reviewPrNumber}`} target="_blank" rel="noreferrer"
                        className="inline-flex min-h-11 items-center font-medium underline text-blue-200">
                        PR #{task.reviewPrNumber}{!task.merged && task.status === "review" ? ` · ${m.reviewOnGithub}` : ""} ↗
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-400">{m.mergeObserved}</p>
        </div>
      ) : null}
    </section>
  );
}
