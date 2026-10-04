/**
 * The QA-release merge lane's latch: why it is set, and when it may be set
 * or released.
 *
 * docs/policy/qa-release-agent.md (version 4), section 8 item 5. The latch is
 * an append-only list of events in QaReleaseMergeLaneLatch; the lane is
 * latched when the newest event sets it. The lane sets it, with one of the
 * reasons below, and may set it again while it is set (each a new alert); a
 * person releases it, and only while it is set. A latch never closes an
 * attempt. The QaReleaseMergeLaneLatch migration enforces the same rules,
 * and tests/qaReleaseMergeLaneLatchCore.test.mjs checks the two lists.
 */

export const QA_RELEASE_MERGE_LANE_LATCH_REASONS = [
  /** The merge call's result is not known (section 3 step 4, section 8 item 5). */
  "merge_result_unknown",
  /** deploymentOutcome read `failed`. */
  "deploy_failed",
  /** deploymentOutcome read `unknown`. */
  "deploy_unknown",
  /** `not_seen` past 15 minutes, or `in_progress`/`partial` past 120. */
  "deploy_wait_exceeded",
  /** Railway, the containing commits or the cancelled commits could not be read. */
  "deploy_unreadable",
  /** No result report arrived within 12 minutes. */
  "result_not_reported",
  /** The re-read found the pull request merged onto another base. */
  "merged_off_develop",
  /** The compare API said the merge commit is not on develop, or did not answer. */
  "merge_commit_off_develop",
  /** A result report named another operator control revision than the newest. */
  "revision_mismatch",
] as const;
export type QaReleaseMergeLaneLatchReason = (typeof QA_RELEASE_MERGE_LANE_LATCH_REASONS)[number];

/** Whether the lane is latched, from its newest event; no event is not latched. */
export const qaReleaseMergeLaneLatched = (newest: { latched: boolean } | null): boolean => newest?.latched === true;

export type QaReleaseMergeLaneLatchEvent =
  | { kind: "set"; reason: QaReleaseMergeLaneLatchReason }
  | { kind: "release" };

/**
 * Whether an event may follow the newest one. Setting is always allowed --
 * a second cause while latched is recorded and alerted, never dropped -- and
 * releasing needs the lane to be latched.
 */
export function qaReleaseMergeLaneLatchEventAllowed(
  newest: { latched: boolean } | null,
  event: QaReleaseMergeLaneLatchEvent,
): boolean {
  if (event.kind === "set") return (QA_RELEASE_MERGE_LANE_LATCH_REASONS as readonly string[]).includes(event.reason);
  return qaReleaseMergeLaneLatched(newest);
}
