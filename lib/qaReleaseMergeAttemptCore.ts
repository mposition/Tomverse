/**
 * The QA-release merge lane attempt: its states, its outcomes and the only
 * transitions between them.
 *
 * docs/policy/qa-release-agent.md (version 4), section 8 item 5. This table is
 * the single statement of the lifecycle; the QaReleaseMergeAttempt migration's
 * trigger enforces the same table in the database, and
 * tests/qaReleaseMergeAttemptCore.test.mjs checks the two against each other.
 *
 * An attempt is open from issue until its outcome is known: issued, then
 * consumed when the app lets the service merge, then awaiting deploy once a
 * merge landed on develop, then closed. A latch never closes an attempt.
 */

export const QA_RELEASE_MERGE_ATTEMPT_STATES = ["issued", "consumed", "awaiting_deploy", "closed"] as const;
export type QaReleaseMergeAttemptState = (typeof QA_RELEASE_MERGE_ATTEMPT_STATES)[number];

/** Open states: the lane holds at most one attempt in any of them (a database constraint). */
export const QA_RELEASE_MERGE_ATTEMPT_OPEN_STATES: readonly QaReleaseMergeAttemptState[] = [
  "issued",
  "consumed",
  "awaiting_deploy",
];

/**
 * Why a closed attempt closed. Each names who decided it: the lane from what
 * it read, or a person from what they confirmed (section 8 item 5).
 */
export const QA_RELEASE_MERGE_ATTEMPT_OUTCOMES = [
  /** deploymentOutcome read `succeeded`. */
  "deployed",
  /** deploymentOutcome read `failed`; the lane latched. */
  "deploy_failed",
  /** GitHub refused the merge call. */
  "merge_refused",
  /** The re-read found the pull request not merged. */
  "not_merged",
  /** The re-read found it merged onto another base; the lane latched. */
  "merged_off_develop",
  /** A person confirmed it was not merged into develop. */
  "person_not_merged",
  /** A person confirmed every develop service serves the merge or a later commit containing it. */
  "person_deployed",
  /** A person confirmed staging was restored by the runbook. */
  "person_restored",
] as const;
export type QaReleaseMergeAttemptOutcome = (typeof QA_RELEASE_MERGE_ATTEMPT_OUTCOMES)[number];

/**
 * Every allowed change of state, with the outcomes a move to `closed` may
 * carry. Anything not listed is refused, including staying in place.
 */
export const QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS: ReadonlyArray<{
  from: QaReleaseMergeAttemptState;
  to: QaReleaseMergeAttemptState;
  outcomes?: readonly QaReleaseMergeAttemptOutcome[];
}> = [
  // The app lets the service merge, before the instruction expires.
  { from: "issued", to: "consumed" },
  // The re-read of an instruction that was never reported, or a person's
  // confirmation, places a merge that did land.
  { from: "issued", to: "awaiting_deploy" },
  { from: "issued", to: "closed", outcomes: ["not_merged", "merged_off_develop", "person_not_merged"] },
  { from: "consumed", to: "awaiting_deploy" },
  {
    from: "consumed",
    to: "closed",
    outcomes: ["merge_refused", "not_merged", "merged_off_develop", "person_not_merged"],
  },
  { from: "awaiting_deploy", to: "closed", outcomes: ["deployed", "deploy_failed", "person_deployed", "person_restored"] },
];

/**
 * The one state an attempt may be written in without moving: while awaiting
 * deploy, the lane records the staging deployments it observed (policy
 * section 8 item 5) -- repeated reports included, so the list may be the same.
 * Only the lane, no outcome, and the merge commit unchanged.
 */
export const QA_RELEASE_MERGE_ATTEMPT_OBSERVATION_STATE: QaReleaseMergeAttemptState = "awaiting_deploy";

/** The outcomes only a person may record, through the latch release. */
export const QA_RELEASE_MERGE_ATTEMPT_PERSON_OUTCOMES: readonly QaReleaseMergeAttemptOutcome[] = [
  "person_not_merged",
  "person_deployed",
  "person_restored",
];

export function qaReleaseMergeAttemptTransitionAllowed(
  from: QaReleaseMergeAttemptState,
  to: QaReleaseMergeAttemptState,
  outcome: QaReleaseMergeAttemptOutcome | null,
): boolean {
  const rule = QA_RELEASE_MERGE_ATTEMPT_TRANSITIONS.find((entry) => entry.from === from && entry.to === to);
  if (!rule) return false;
  if (to === "closed") return outcome !== null && (rule.outcomes ?? []).includes(outcome);
  return outcome === null;
}
