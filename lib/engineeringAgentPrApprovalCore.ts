import { ENGINEERING_AGENT_NOT_APPROVED_REASONS } from "./engineeringAgentCore.ts";

/**
 * The approval judgement of engineering-agent.md §9-10: a published pull
 * request is approved only when all seven conditions hold, as the app itself
 * observed them with its read-only token. Pure: the caller reads GitHub and
 * passes what it read. A read it could not complete is `undetermined`, never
 * a refusal, and is looked at again on the next round (condition 3).
 */

/** engineering-agent.md §9-10's PR approver list, by GitHub numeric user id: `mposition`. */
export const ENGINEERING_AGENT_PR_APPROVER_IDS: readonly number[] = [60078951];

export type EngineeringAgentNotApprovedReason = (typeof ENGINEERING_AGENT_NOT_APPROVED_REASONS)[number];

export type EngineeringAgentObservedReview = {
  id: number;
  userId: number;
  state: string;
  commitId: string;
  submittedAt: Date;
};

export type EngineeringAgentPrApprovalInput = {
  baseRef: string;
  headSha: string;
  verifiedHeadSha: string;
  /** The head commit's required checks, or null when the list could not be read whole. */
  requiredChecks: { allPassed: boolean } | null;
  reviews: readonly EngineeringAgentObservedReview[];
  snapshot: { baseSha: string; diffDigest: string; recordedAt: Date; invalidatedReviewIds: readonly number[] };
  /** Base SHA and diff digest recomputed at observation, or null when they could not be. */
  current: { baseSha: string; diffDigest: string } | null;
  approverIds?: readonly number[];
};

export type EngineeringAgentPrApprovalVerdict =
  | { verdict: "approved"; reviewId: number; reviewerId: number; reviewCommitId: string; submittedAt: Date }
  | { verdict: "not_approved"; reason: EngineeringAgentNotApprovedReason }
  | { verdict: "undetermined"; reason: "checks_unreadable" | "snapshot_unreadable" };

/** A user's review state is their latest review that is not a bare comment, as GitHub counts it. */
const latestDecisiveReviews = (reviews: readonly EngineeringAgentObservedReview[]) => {
  const latest = new Map<number, EngineeringAgentObservedReview>();
  for (const review of reviews) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    const seen = latest.get(review.userId);
    if (!seen || review.submittedAt.getTime() > seen.submittedAt.getTime() ||
        (review.submittedAt.getTime() === seen.submittedAt.getTime() && review.id > seen.id)) {
      latest.set(review.userId, review);
    }
  }
  return [...latest.values()];
};

export function decideEngineeringAgentPrApproval(input: EngineeringAgentPrApprovalInput): EngineeringAgentPrApprovalVerdict {
  const approvers = input.approverIds ?? ENGINEERING_AGENT_PR_APPROVER_IDS;
  // 1. The base is the protected develop branch.
  if (input.baseRef !== "develop") return { verdict: "not_approved", reason: "base_not_develop" };
  // 2. The head is the commit the app recorded as verified.
  if (input.headSha !== input.verifiedHeadSha) return { verdict: "not_approved", reason: "head_not_verified" };
  // 3. Every required check of that commit passed; an incomplete read decides nothing.
  if (input.requiredChecks === null) return { verdict: "undetermined", reason: "checks_unreadable" };
  if (!input.requiredChecks.allPassed) return { verdict: "not_approved", reason: "required_check_failed" };
  // 6 is read before 4 and 5: a moved base or diff voids every review, and
  // an unreadable one decides nothing.
  if (input.current === null) return { verdict: "undetermined", reason: "snapshot_unreadable" };
  if (input.current.baseSha !== input.snapshot.baseSha || input.current.diffDigest !== input.snapshot.diffDigest) {
    return { verdict: "not_approved", reason: "snapshot_changed" };
  }
  // 4. An authorised account, matched by numeric id, approved.
  const authorised = latestDecisiveReviews(input.reviews).filter(
    (review) => approvers.includes(review.userId) && review.state === "APPROVED",
  );
  if (authorised.length === 0) return { verdict: "not_approved", reason: "no_authorised_review" };
  // 5. The approval is still valid: not voided by a snapshot rewrite, and on the verified head.
  const valid = authorised.filter(
    (review) => !input.snapshot.invalidatedReviewIds.includes(review.id) && review.commitId === input.verifiedHeadSha,
  );
  if (valid.length === 0) return { verdict: "not_approved", reason: "review_not_valid" };
  // 7. It was submitted after the snapshot was recorded.
  const fresh = valid.filter((review) => review.submittedAt.getTime() > input.snapshot.recordedAt.getTime());
  if (fresh.length === 0) return { verdict: "not_approved", reason: "review_before_snapshot" };
  const chosen = fresh.reduce((a, b) => (b.submittedAt.getTime() > a.submittedAt.getTime() ? b : a));
  return {
    verdict: "approved",
    reviewId: chosen.id,
    reviewerId: chosen.userId,
    reviewCommitId: chosen.commitId,
    submittedAt: chosen.submittedAt,
  };
}

/**
 * Approval is settled before the merge (engineering-agent.md §9-10), or by
 * the merge itself when an account on the approver list merged into develop
 * (owner decision 2026-11-12: one person reviews and merges their own agent's
 * pull request, so a separate GitHub review was never written and every such
 * merge stopped the agent).
 *
 * Owner decision 2026-11-15 (`approverMergeApprovesMergedDiff`, the default):
 * the approver's merge approves whatever head and diff it merged. A person
 * who merges on GitHub merges the diff GitHub shows them then, so a head that
 * moved after verification -- develop merged in, a conflict the CI auto-fix
 * resolved, the owner's own push -- is still that person's approval; the
 * observer records the merged head and diff with it. Before it (and with
 * ENGINEERING_AGENT_LEGACY_HALTS) the approver's merge counted only at the
 * verified head or the verified diff.
 *
 * An approval recorded before the merge still stands for a merge of the
 * verified head or diff, and for the approver's own merge. It no longer
 * stands for someone else's merge of a head that moved after it: the review
 * approved a diff that is not the one merged (with the kill switch on it
 * still does, as before).
 *
 * Any other merge -- a bot's, an app's, another account's, into main -- is
 * not approved, whatever its reviews say now. It opens a decision for that
 * card; it no longer stops the agent (engineeringAgentMismatchCardScoped).
 */
export function decideEngineeringAgentMergedPr(input: {
  merged: boolean;
  approvalRecordedBeforeMerge: boolean;
  /** The merger is a person on the approver list (lib/engineeringAgentGitHubRead.ts). */
  mergedByApprover?: boolean;
  baseRef?: string;
  /** The merged head is the commit the app recorded as verified, or its diff is the verified one. */
  headVerified?: boolean;
  /** Owner decision 2026-11-15: the approver's develop merge approves the diff it merged. */
  approverMergeApprovesMergedDiff?: boolean;
}): "done" | "merged_without_approval" | "open" {
  if (!input.merged) return "open";
  const approverMerge = input.mergedByApprover === true && input.baseRef === "develop";
  const sameChange = input.headVerified === true;
  if (input.approvalRecordedBeforeMerge &&
      (input.approverMergeApprovesMergedDiff !== true || sameChange || approverMerge)) return "done";
  if (!approverMerge) return "merged_without_approval";
  return sameChange || input.approverMergeApprovesMergedDiff === true ? "done" : "merged_without_approval";
}

/**
 * The second basis of approval (owner decision 2026-11-13: "develop 병합 권한은
 * DM에게 승인합니다. main은 안됩니다."): a merge the approver list did not make
 * is approved when the Decision Maker approved this pull request from the
 * owner queue before the merge, of exactly the merged head and diff, the base
 * is develop, and the merge is the QA-release merge lane's own -- a bot's
 * merge whose commit the lane reported for this pull request and head. While
 * the lane has an attempt open for it and has not reported yet, or the diff
 * cannot be read, nothing is decided: the observer reads it again next round.
 * Anything else is not this basis, and the merge stays unapproved.
 */
export function decideEngineeringAgentDmApprovedMerge(input: {
  baseRef: string;
  headSha: string;
  /** The merged pull request's diff digest, or null when it could not be read. */
  diffDigest: string | null;
  mergedAt: Date;
  mergedByKind: "user" | "bot" | "app" | "unknown";
  /** The Decision Maker's approval of this binding's pull request, or null when there is none. */
  approval: { approvedHeadSha: string; approvedDiffDigest: string; decidedAt: Date } | null;
  /** The merge lane's record of this pull request and head: it reported this merge commit, or an attempt is still open. */
  laneMerge: "merged" | "pending" | null;
}): "done" | "waiting" | "not_approved" {
  const { approval } = input;
  if (approval === null || input.baseRef !== "develop" || input.headSha !== approval.approvedHeadSha ||
      approval.decidedAt.getTime() > input.mergedAt.getTime() ||
      (input.mergedByKind !== "bot" && input.mergedByKind !== "app")) return "not_approved";
  if (input.diffDigest === null) return "waiting";
  if (input.diffDigest !== approval.approvedDiffDigest) return "not_approved";
  if (input.laneMerge === "merged") return "done";
  return input.laneMerge === "pending" ? "waiting" : "not_approved";
}
