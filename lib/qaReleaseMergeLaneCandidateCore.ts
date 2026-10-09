/**
 * Which develop pull request the QA-release merge lane would merge next.
 *
 * docs/policy/qa-release-agent.md (version 3), section 8 item 2: the oldest
 * pull request into develop that is not a draft, whose checks are complete
 * with no failure and at least one successful PR Fast Gate run, and that is
 * mergeable -- with the item 3 exclusion decided inside the selection, so an
 * excluded pull request is skipped with its reasons exactly like a red one
 * and never holds up the ones behind it.
 *
 * The readiness rule is the operator merge train's own
 * (`refusalReason`, scripts/merge-train-core.mjs), reused rather than
 * restated. Pure: every input comes from the caller, and an exclusion that
 * was not judged is a skip, never a pick.
 */
import { refusalReason } from "../scripts/merge-train-core.mjs";
import type { QaReleaseExclusion, QaReleaseExclusionReason } from "./qaReleaseMergeLaneExclusionCore.ts";

export const QA_RELEASE_MERGE_LANE_BRANCH = "develop";

/** The fields of `gh pr list --json` that the selection reads. */
export type QaReleaseLanePullRequest = {
  number: number;
  createdAt: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  mergeable: string;
  state?: string;
  statusCheckRollup: unknown[];
};

export type QaReleaseLaneSkip =
  | { number: number; kind: "not_ready"; reason: string }
  | { number: number; kind: "excluded"; reasons: QaReleaseExclusionReason[] }
  | { number: number; kind: "exclusion_unjudged" };

export type QaReleaseLaneSelection = {
  pick: QaReleaseLanePullRequest | null;
  /** Every pull request passed over, oldest first, with why. */
  skipped: QaReleaseLaneSkip[];
};

const createdAtMs = (pr: QaReleaseLanePullRequest): number => {
  const ms = Date.parse(pr.createdAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

/**
 * Chooses the lane's next pull request. `exclusions` holds the item 3
 * judgement per pull request number; one missing from it is not judged and
 * is skipped. Readiness is checked before exclusion only to keep the reason
 * that is cheapest to read first; both are skips either way.
 */
export function pickQaReleaseLaneCandidate(
  pullRequests: readonly QaReleaseLanePullRequest[],
  exclusions: ReadonlyMap<number, QaReleaseExclusion>,
): QaReleaseLaneSelection {
  const ordered = pullRequests
    .filter((pr) => pr.baseRefName === QA_RELEASE_MERGE_LANE_BRANCH)
    .slice()
    .sort((a, b) => createdAtMs(a) - createdAtMs(b) || a.number - b.number);

  const skipped: QaReleaseLaneSkip[] = [];
  for (const pr of ordered) {
    const notReady = refusalReason(pr, QA_RELEASE_MERGE_LANE_BRANCH) as string | null;
    if (notReady !== null) {
      skipped.push({ number: pr.number, kind: "not_ready", reason: notReady });
      continue;
    }
    const exclusion = exclusions.get(pr.number);
    if (exclusion === undefined) {
      skipped.push({ number: pr.number, kind: "exclusion_unjudged" });
      continue;
    }
    if (exclusion.excluded) {
      skipped.push({ number: pr.number, kind: "excluded", reasons: [...exclusion.reasons] });
      continue;
    }
    return { pick: pr, skipped };
  }
  return { pick: null, skipped };
}
