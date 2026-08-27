// What "deployed" and "merged" being different actually means.
//
// On 2026-08-26 three pull requests merged into `main` within three minutes.
// None of them deployed. Railway's Wait for CI held each one until its commit's
// check suite finished, the suites were still running, and the deployment that
// eventually succeeded was an *older* commit whose checks had already passed.
// Production served that older commit for over an hour with nothing saying so:
// the pull requests were merged and green, the Actions list was green, and the
// only place the truth existed was the Railway dashboard.
//
// `/api/build-info` has always been able to answer "which commit is running".
// Nothing asked it on a schedule. This module is the comparison, kept pure so
// it can be tested without a network or a checkout.
//
// Two decisions are worth stating because they are what make the answer useful
// rather than merely correct.
//
// **Lag is measured from the oldest undeployed commit, not the newest.** A
// branch that has moved twice since the last deploy has been undeployed since
// the *first* of those commits, and that is how long the gap has actually
// existed. Measuring from the newest resets the clock every time someone
// merges, which is exactly when the number needs to keep climbing.
//
// **Being behind is not by itself a fault.** Between a merge and its deploy
// there is always a gap, and with Wait for CI it is as long as the suite. The
// verdict therefore reports the lag and compares it against a threshold rather
// than treating any difference as an incident -- a detector that fires on every
// merge is one nobody reads.

/** Deployed commit matches the branch head. */
export const IN_SYNC = "in_sync";
/** Branch head has commits the deployed commit does not. */
export const BEHIND = "behind";
/**
 * The deployed commit is not an ancestor of the head: a force-push, a revert
 * of the branch, a deploy from somewhere else, or a rollback to a commit that
 * has since left the branch. Not "behind" -- counting commits between them
 * would be meaningless -- and never silently folded into it.
 */
export const DIVERGED = "diverged";
/** Nothing to compare: the endpoint gave no commit, or it is not in the tree. */
export const UNKNOWN = "unknown";

/**
 * @param {object} input
 * @param {string|null} input.deployedSha commit `/api/build-info` reports
 * @param {string|null} input.headSha commit the branch points at
 * @param {boolean} input.deployedShaKnown whether the deployed commit exists in
 *   the checkout at all. A shallow clone, or a commit from another branch, is
 *   not the same fact as "no commit reported" and must not read as one.
 * @param {Array<{sha: string, committedAt: string}>} input.undeployed commits
 *   reachable from the head but not from the deployed commit, newest first.
 * @param {string} input.now ISO timestamp to measure the lag against.
 * @param {number} input.thresholdMinutes how long a gap may stand before it is
 *   worth someone's attention.
 */
export function deployedCommitDrift({
  deployedSha,
  headSha,
  deployedShaKnown,
  undeployed,
  now,
  thresholdMinutes,
}) {
  const base = {
    deployedSha: deployedSha || null,
    headSha: headSha || null,
    commitsBehind: null,
    oldestUndeployedSha: null,
    oldestUndeployedAt: null,
    lagMinutes: null,
    thresholdMinutes,
    exceedsThreshold: false,
  };

  if (!deployedSha || !headSha) {
    return { ...base, state: UNKNOWN, reason: "no commit reported" };
  }
  if (deployedSha === headSha) {
    return { ...base, state: IN_SYNC, commitsBehind: 0, lagMinutes: 0 };
  }
  if (!deployedShaKnown) {
    // Said separately from "diverged" on purpose. A commit this checkout has
    // never seen is a fact about the checkout; concluding the branch diverged
    // from it would be an assertion nothing here can support.
    return {
      ...base,
      state: UNKNOWN,
      reason: "the deployed commit is not in this checkout",
    };
  }
  if (undeployed.length === 0) {
    return { ...base, state: DIVERGED, reason: "the deployed commit is not an ancestor of the head" };
  }

  const oldest = undeployed[undeployed.length - 1];
  const lagMs = Date.parse(now) - Date.parse(oldest.committedAt);
  // A commit dated in the future -- a wrong clock on whatever wrote it -- must
  // not produce a negative lag that reads as "deployed early".
  const lagMinutes = Math.max(0, Math.round(lagMs / 60000));
  return {
    ...base,
    state: BEHIND,
    commitsBehind: undeployed.length,
    oldestUndeployedSha: oldest.sha,
    oldestUndeployedAt: oldest.committedAt,
    lagMinutes,
    exceedsThreshold: lagMinutes > thresholdMinutes,
  };
}

/** One line an operator can act on, or ignore, without opening a dashboard. */
export function describeDrift(environment, drift) {
  const short = (sha) => (sha ? sha.slice(0, 8) : "unknown");
  if (drift.state === IN_SYNC) {
    return `${environment}: in sync at ${short(drift.deployedSha)}.`;
  }
  if (drift.state === UNKNOWN) {
    return `${environment}: cannot compare — ${drift.reason}.`;
  }
  if (drift.state === DIVERGED) {
    return (
      `${environment}: serving ${short(drift.deployedSha)}, which is not an ancestor of ` +
      `${short(drift.headSha)}. A rollback, a force-push, or a deploy from elsewhere.`
    );
  }
  const plural = drift.commitsBehind === 1 ? "commit" : "commits";
  return (
    `${environment}: ${drift.commitsBehind} ${plural} behind — serving ${short(drift.deployedSha)}, ` +
    `head is ${short(drift.headSha)}. The oldest undeployed commit ` +
    `(${short(drift.oldestUndeployedSha)}) has been waiting ${drift.lagMinutes} minutes` +
    `${drift.exceedsThreshold ? `, past the ${drift.thresholdMinutes}-minute threshold` : ""}.`
  );
}
