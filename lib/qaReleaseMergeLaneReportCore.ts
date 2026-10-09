/**
 * What a QA-release merge lane result report does to the attempt and the
 * latch.
 *
 * docs/policy/qa-release-agent.md (version 4), section 8 item 5 and section 6.
 * A report names the attempt state it is about; the app moves the attempt
 * only from that state (a conditional update), and latches when the report
 * says the outcome is unknown or bad -- or when the caller ran under another
 * operator control revision than the newest, in which case the report is
 * still recorded but never closes a deploy as a success.
 *
 * Pure: lib/qaReleaseMergeLaneStore.ts applies the answer in one
 * transaction.
 */
import type { QaReleaseMergeAttemptOutcome, QaReleaseMergeAttemptState } from "./qaReleaseMergeAttemptCore.ts";
import type { QaReleaseMergeLaneLatchReason } from "./qaReleaseMergeLaneLatchCore.ts";

const SHA = /^[0-9a-f]{40}$/;

/**
 * One staging service's deployment as the lane observed it for this merge:
 * a service name, Railway's status and the deployed commit. Shown to a
 * person deciding whether staging serves the merge (section 8 item 5).
 */
export type QaReleaseDeployObservation = { service: string; status: string; commitSha: string | null };

const RAILWAY_STATUSES = new Set([
  "WAITING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "DEPLOYING",
  "SUCCESS",
  "SLEEPING",
  "FAILED",
  "CRASHED",
  "SKIPPED",
  "REMOVED",
  "REMOVING",
]);
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** At most 20 entries of a closed shape, or null: nothing a service read from GitHub or a log. */
export function qaReleaseDeployObservation(value: unknown): QaReleaseDeployObservation[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const entries: QaReleaseDeployObservation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { service, status, commitSha, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return null;
    if (typeof service !== "string" || !SERVICE_NAME.test(service)) return null;
    if (typeof status !== "string" || !RAILWAY_STATUSES.has(status)) return null;
    if (commitSha !== null && (typeof commitSha !== "string" || !SHA.test(commitSha))) return null;
    entries.push({ service, status, commitSha: commitSha as string | null });
  }
  return entries;
}

export type QaReleaseMergeReport =
  /** The merge call's answer, for a consumed attempt (section 3 step 4). */
  | { kind: "merge"; result: "merged"; mergeCommitSha: string }
  | { kind: "merge"; result: "refused" }
  | { kind: "merge"; result: "unknown" }
  /** deploymentOutcome for an attempt awaiting deploy, with the waits' limits applied. */
  | {
      kind: "deploy";
      outcome: "succeeded" | "failed" | "unknown" | "wait_exceeded" | "unreadable";
      /** What the lane saw; empty when Railway could not be read. */
      observation: QaReleaseDeployObservation[];
    }
  /** No result report within 12 minutes of an issued or consumed attempt. */
  | { kind: "unreported" }
  /** The ordered pull-request re-read for an issued or consumed attempt, at its first answering step. */
  | { kind: "reread"; result: "not_merged" }
  | { kind: "reread"; result: "merged_off_develop" }
  | { kind: "reread"; result: "merged_on_develop"; mergeCommitSha: string }
  | { kind: "reread"; result: "merge_commit_off_develop" };

export type QaReleaseReportEffect = {
  /** The states this report may be about; the update is conditional on one of them. */
  from: readonly QaReleaseMergeAttemptState[];
  /** The attempt's new state and outcome, or null when the attempt stays as it is. */
  move: { to: QaReleaseMergeAttemptState; outcome: QaReleaseMergeAttemptOutcome | null; mergeCommitSha?: string } | null;
  /** The latch reason this report records, or null. */
  latch: QaReleaseMergeLaneLatchReason | null;
};

const PRE_MERGE: readonly QaReleaseMergeAttemptState[] = ["issued", "consumed"];

/** The report's own effect, before the revision check. Throws on a malformed report. */
export function qaReleaseReportEffect(report: QaReleaseMergeReport): QaReleaseReportEffect {
  switch (report.kind) {
    case "merge":
      if (report.result === "merged") {
        if (!SHA.test(report.mergeCommitSha)) throw new RangeError("mergeCommitSha must be a full SHA");
        return { from: ["consumed"], move: { to: "awaiting_deploy", outcome: null, mergeCommitSha: report.mergeCommitSha }, latch: null };
      }
      if (report.result === "refused") return { from: ["consumed"], move: { to: "closed", outcome: "merge_refused" }, latch: null };
      return { from: ["consumed"], move: null, latch: "merge_result_unknown" };
    case "deploy":
      if (qaReleaseDeployObservation(report.observation) === null) throw new RangeError("observation is not a deployment list");
      switch (report.outcome) {
        case "succeeded":
          return { from: ["awaiting_deploy"], move: { to: "closed", outcome: "deployed" }, latch: null };
        case "failed":
          return { from: ["awaiting_deploy"], move: { to: "closed", outcome: "deploy_failed" }, latch: "deploy_failed" };
        case "unknown":
          return { from: ["awaiting_deploy"], move: null, latch: "deploy_unknown" };
        case "wait_exceeded":
          return { from: ["awaiting_deploy"], move: null, latch: "deploy_wait_exceeded" };
        case "unreadable":
          return { from: ["awaiting_deploy"], move: null, latch: "deploy_unreadable" };
      }
      throw new RangeError("unknown deploy outcome");
    case "unreported":
      return { from: PRE_MERGE, move: null, latch: "result_not_reported" };
    case "reread":
      switch (report.result) {
        case "not_merged":
          return { from: PRE_MERGE, move: { to: "closed", outcome: "not_merged" }, latch: null };
        case "merged_off_develop":
          return { from: PRE_MERGE, move: { to: "closed", outcome: "merged_off_develop" }, latch: "merged_off_develop" };
        case "merged_on_develop":
          if (!SHA.test(report.mergeCommitSha)) throw new RangeError("mergeCommitSha must be a full SHA");
          return { from: PRE_MERGE, move: { to: "awaiting_deploy", outcome: null, mergeCommitSha: report.mergeCommitSha }, latch: null };
        case "merge_commit_off_develop":
          return { from: PRE_MERGE, move: null, latch: "merge_commit_off_develop" };
      }
      throw new RangeError("unknown re-read result");
  }
  throw new RangeError("unknown report kind");
}

/**
 * The effect once the revision is known. A report from a caller on another
 * revision is recorded and latches; it never closes a deploy as a success,
 * and when the report latches for its own reason that reason is kept.
 */
export function qaReleaseReportEffectUnderRevision(effect: QaReleaseReportEffect, revisionMatches: boolean): QaReleaseReportEffect {
  if (revisionMatches) return effect;
  const closesAsSuccess = effect.move?.to === "closed" && effect.move.outcome === "deployed";
  return {
    from: effect.from,
    move: closesAsSuccess ? null : effect.move,
    latch: effect.latch ?? "revision_mismatch",
  };
}
