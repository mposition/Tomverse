import type { QaReleaseLaneRoundVerdict } from "./qaReleaseMergeLaneRoundStore.ts";

/**
 * The merge lane's latest verdicts as GitHub stands now, for the Admin lane
 * tab between the lane's rounds (it runs every 10 minutes; owner, 2026-10-24:
 * "a merged pull request and one whose CI finished still show"):
 *
 * - a pull request no longer open (closed or merged) is dropped;
 * - one the lane saw with CI running (`checks_pending`) whose CI runs no
 *   more says `checks_done`: the lane judges the result on its next round.
 *
 * Everything else is the lane's own verdict. `github` null (not read) leaves
 * the list as recorded. Pure.
 */
export const QA_RELEASE_LANE_CHECKS_DONE = "checks_done";

export function qaReleaseLaneLiveVerdicts(
  list: readonly QaReleaseLaneRoundVerdict[],
  github: { open: readonly number[]; ciRunning: readonly number[] } | null,
): QaReleaseLaneRoundVerdict[] {
  if (!github) return [...list];
  const open = new Set(github.open);
  const running = new Set(github.ciRunning);
  return list
    .filter((verdict) => open.has(verdict.number))
    .map((verdict) =>
      verdict.reasons.includes("checks_pending") && !running.has(verdict.number)
        ? { ...verdict, reasons: verdict.reasons.map((reason) => (reason === "checks_pending" ? QA_RELEASE_LANE_CHECKS_DONE : reason)) }
        : verdict,
    );
}
