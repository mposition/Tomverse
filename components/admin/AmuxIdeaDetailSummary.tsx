"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxSessionAnalysisStopPanel } from "@/components/admin/AmuxSessionAnalysisStopPanel";
import { AmuxSessionIdeaCancelPanel } from "@/components/admin/AmuxSessionIdeaCancelPanel";
import { AmuxReadManifestPathsPanel } from "@/components/admin/AmuxReadManifestPathsPanel";
import { AmuxSessionReviewPanel } from "@/components/admin/AmuxSessionReviewPanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { amuxIdeaHasUnsavedDraft } from "@/lib/amux/ideaDraftGuard";
import { AMUX_IDEA_PROGRESS_STAGES, amuxIdeaProgressStep } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const REPOSITORY_URL = "https://github.com/mposition/Tomverse";
/** The steps a person takes; every other step runs on its own. */
const HUMAN_STEPS = new Set(["execution_approval", "plan_approval", "review"]);
const EXCLUSION_REASONS = ["secretPath", "secretContent", "nonRegular",
  "unscannableContent"] as const;

/**
 * The top of one idea's detail (approved backlog redesign, B3): where the idea
 * is on the six steps, which of them are a person's, and its Tasks with their
 * PRs. Everything here is read from the progress snapshot; there is no action
 * besides opening GitHub, reading its own CLI manifest, cancelling a queued v19 session idea and
 * stopping its in-flight analysis, because
 * other human steps have their own panels below and merge is observed here.
 */
export function AmuxIdeaDetailSummary({ row }: { row: AmuxIdeaProgressRow }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const step = amuxIdeaProgressStep(row.stage);
  return (
    <section className="space-y-4 rounded-xl border p-4 text-sm border-zinc-800 bg-zinc-900/60"
      aria-labelledby="amux-idea-detail-heading" data-testid="amux-idea-detail" data-stage={row.stage}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="amux-idea-detail-heading" className="text-lg font-semibold text-zinc-100">
          {row.displayKey ?? `${m.untitled} ${row.requestId.slice(0, 8)}`}
        </h2>
        <Link href="/admin/amux-backlog?tab=ideas" onClick={(event) => {
          // A new draft started from this idea is never stored; ask before leaving it.
          if (amuxIdeaHasUnsavedDraft() && !window.confirm(m.leaveDraft)) event.preventDefault();
        }} className="min-h-11 content-center text-sm font-medium underline text-blue-200">
          {m.backToList}
        </Link>
      </div>
      {row.attention ? <p role="alert" className="text-red-200">{m.attentionDetail}</p> : null}
      <ol className="grid gap-2 sm:grid-cols-6" aria-label={m.stepsLabel}>
        {AMUX_IDEA_PROGRESS_STAGES.map((stage, index) => {
          const position = index + 1;
          const state = step === null ? "later" : position < step ? "done" : position === step ? "current" : "later";
          return (
            <li key={stage} aria-current={state === "current" ? "step" : undefined}
              className={`rounded-lg border p-2 ${state === "current"
                ? (row.attention ? "border-red-400" : HUMAN_STEPS.has(stage) ? "border-amber-400" : "border-blue-400")
                : state === "done" ? "border-blue-500/30" : "border-zinc-800"}`}>
              <span className="block text-xs text-zinc-400">{position}</span>
              <span className="block font-medium text-zinc-100">{m.stages[stage]}</span>
              <span className="block text-xs text-zinc-400">
                {state === "done" ? m.stepDone : HUMAN_STEPS.has(stage) ? m.human : m.automatic}
              </span>
            </li>
          );
        })}
      </ol>
      {row.stage === "cancelled" ? <p>{m.stages.cancelled}</p> : null}
      {row.waitingFor === "session_review" ? (
        <p className="text-amber-200" data-testid="amux-session-review">{m.sessionReviewDetail}</p>
      ) : null}
      {row.waitingFor === "session_review" && row.submissionOrigin === "session" ?
        <AmuxSessionReviewPanel ideaId={row.ideaId} /> : null}
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
                {evidence.readManifest ? (
                  <div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-300"
                    data-testid="amux-checkout-read-manifest">
                    <p>{m.checkoutReadFiles(evidence.readManifest.fileCount)}</p>
                    <p>{evidence.readManifest.bodyPurged ? m.checkoutReadPurged : m.checkoutReadEncrypted}</p>
                    <p>{m.checkoutReadDigest}: <code className="break-all text-zinc-100">
                      {evidence.readManifest.digest}</code></p>
                    {!evidence.readManifest.bodyPurged ? (
                      <AmuxReadManifestPathsPanel ideaId={row.ideaId}
                        referenceOrdinal={evidence.referenceOrdinal}
                        fileCount={evidence.readManifest.fileCount} />
                    ) : null}
                  </div>
                ) : null}
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
                  <td className="py-2 pr-3">{task.merged ? m.taskMerged : task.status}</td>
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
