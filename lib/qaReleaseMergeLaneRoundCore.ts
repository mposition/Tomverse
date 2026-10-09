/**
 * What one QA-release merge lane round does, and whether a merge it made
 * landed where it had to.
 *
 * docs/policy/qa-release-agent.md (version 3), section 8: items 4 (hold while
 * any staging service has a deployment in flight), 5 (one attempt per lane;
 * an unknown outcome latches, and only a person clears a latch) and 3 step 4
 * (after a merge, the pull request must read as merged into develop with its
 * merge commit in develop's history, or the lane latches).
 *
 * Pure. The caller reads the latch and the in-flight attempt from the app
 * database, the deployments from Railway and the selection from
 * pickQaReleaseLaneCandidate; anything it could not read is passed as
 * unknown, and unknown never proceeds.
 */
import { inFlightDeployments } from "../scripts/merge-train-core.mjs";
import type { QaReleaseLanePullRequest, QaReleaseLaneSelection } from "./qaReleaseMergeLaneCandidateCore.ts";

export type QaReleaseLaneRoundInput = {
  /** The lane's latch, from the app database; null when it could not be read. */
  latched: boolean | null;
  /** Whether an attempt row is still open, from the app database; null when unread. */
  attemptOpen: boolean | null;
  /** Every staging service's deployments, from Railway; null when unread. */
  stagingDeployments: readonly { status: string }[] | null;
  selection: QaReleaseLaneSelection;
};

export type QaReleaseLaneRound =
  | { action: "stop"; reason: "latched" | "state_unknown" | "attempt_open" | "deployments_unknown" }
  | { action: "hold"; reason: "deployment_in_flight"; inFlight: number }
  | { action: "idle" }
  | { action: "request_instruction"; pullRequest: QaReleaseLanePullRequest };

export function decideQaReleaseLaneRound(input: QaReleaseLaneRoundInput): QaReleaseLaneRound {
  if (input.latched === null || input.attemptOpen === null) return { action: "stop", reason: "state_unknown" };
  if (input.latched) return { action: "stop", reason: "latched" };
  // One attempt per lane: an open one is either running elsewhere or its
  // outcome is unknown, and both mean this round does nothing.
  if (input.attemptOpen) return { action: "stop", reason: "attempt_open" };
  if (!Array.isArray(input.stagingDeployments)) return { action: "stop", reason: "deployments_unknown" };
  const inFlight = inFlightDeployments(input.stagingDeployments).length;
  if (inFlight > 0) return { action: "hold", reason: "deployment_in_flight", inFlight };
  if (input.selection.pick === null) return { action: "idle" };
  return { action: "request_instruction", pullRequest: input.selection.pick };
}

/** The pull request as read back after the merge call returned success. */
export type QaReleaseMergedReadBack = {
  merged: boolean | null;
  baseRefName: string | null;
  mergeCommitSha: string | null;
  /** Whether that merge commit is in develop's history; null when unread. */
  mergeCommitOnDevelop: boolean | null;
};

export type QaReleaseMergeLanding =
  | { landed: true; mergeCommitSha: string }
  | { landed: false; latch: true; reason: "not_merged" | "wrong_base" | "not_on_develop" | "unknown" };

const SHA = /^[0-9a-f]{40}$/;

/**
 * Whether a merge the lane made landed on develop. Anything but a clear yes
 * latches the lane with its outcome unknown: the base could have been changed
 * after the instruction was consumed, which the head pin does not stop
 * (policy section 3, item 3 of the instruction steps).
 */
export function judgeQaReleaseMergeLanding(readBack: QaReleaseMergedReadBack): QaReleaseMergeLanding {
  if (readBack.merged === null || readBack.baseRefName === null || readBack.mergeCommitOnDevelop === null) {
    return { landed: false, latch: true, reason: "unknown" };
  }
  if (!readBack.merged) return { landed: false, latch: true, reason: "not_merged" };
  if (readBack.baseRefName !== "develop") return { landed: false, latch: true, reason: "wrong_base" };
  if (readBack.mergeCommitSha === null || !SHA.test(readBack.mergeCommitSha)) {
    return { landed: false, latch: true, reason: "unknown" };
  }
  if (!readBack.mergeCommitOnDevelop) return { landed: false, latch: true, reason: "not_on_develop" };
  return { landed: true, mergeCommitSha: readBack.mergeCommitSha };
}
