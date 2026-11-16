/**
 * The QA-release merge lane's latch: why it is set, and when it may be set
 * or released.
 *
 * docs/policy/qa-release-agent.md (version 4), section 8 item 5. The latch is
 * an append-only list of events in QaReleaseMergeLaneLatch; the lane is
 * latched when the newest event sets it. The lane sets it, with one of the
 * reasons below, and may set it again while it is set (each a new alert); a
 * person releases it, and only while it is set. Since owner decision
 * 2026-11-16 the lane releases it too, on develop only, once it read again
 * what latched it (qaReleaseMergeLaneSystemReleasable). A latch never closes
 * an attempt. The QaReleaseMergeLaneLatch migrations enforce the same rules,
 * and tests/qaReleaseMergeLaneLatchCore.test.mjs checks the lists.
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

/**
 * The reasons the lane may release itself (owner decision 2026-11-16, develop
 * and its dev deployment only): an outcome it did not know, and a dev deploy
 * that failed, could not be judged or took too long. Each is a fact the lane
 * reads again -- the pull request, the compare API, Railway -- and an
 * attempt it names ends on what the lane read. A merge onto another base,
 * a merge commit off develop and a revision mismatch stay a person's: main,
 * production and the operator's control are never the lane's to judge.
 */
export const QA_RELEASE_MERGE_LANE_SYSTEM_RELEASABLE_REASONS = [
  "merge_result_unknown",
  "deploy_failed",
  "deploy_unknown",
  "deploy_wait_exceeded",
  "deploy_unreadable",
  "result_not_reported",
] as const satisfies readonly QaReleaseMergeLaneLatchReason[];

/** The outcomes the lane itself read that end an attempt a releasable latch named. */
export const QA_RELEASE_MERGE_LANE_SYSTEM_RELEASE_OUTCOMES = ["deployed", "deploy_failed", "merge_refused", "not_merged"] as const;

export type QaReleaseMergeLaneSetSinceRelease = {
  reason: string;
  attempt: { state: string; outcome: string | null } | null;
};

/**
 * Whether the lane may release its latch: it is latched, no attempt is open,
 * every set event since the last release has a releasable reason and names an
 * attempt that closed on an outcome the lane read, and the lane has just read
 * dev as deploying nothing broken (`devHealthy`, its own Railway reading --
 * the same check it makes before every merge). The migration
 * `qa_release_merge_lane_latch_system_release` enforces the same, all but
 * the Railway reading, which the database cannot see.
 */
export function qaReleaseMergeLaneSystemReleasable(input: {
  latched: boolean;
  attemptOpen: boolean;
  setsSinceRelease: readonly QaReleaseMergeLaneSetSinceRelease[];
  devHealthy: boolean;
}): boolean {
  return input.latched && !input.attemptOpen && input.devHealthy && input.setsSinceRelease.length > 0 &&
    input.setsSinceRelease.every((event) =>
      (QA_RELEASE_MERGE_LANE_SYSTEM_RELEASABLE_REASONS as readonly string[]).includes(event.reason) &&
      event.attempt !== null && event.attempt.state === "closed" &&
      (QA_RELEASE_MERGE_LANE_SYSTEM_RELEASE_OUTCOMES as readonly (string | null)[]).includes(event.attempt.outcome));
}
