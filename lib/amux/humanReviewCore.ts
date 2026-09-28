/**
 * Policy version 15: a card that reached Todo through a human-approved
 * promotion carries an approved execution brief, and such a card cannot be
 * settled to done by its worker. The same holds for a card that asks for human
 * review explicitly. Completion goes through the human review route.
 */
export const amuxHumanReviewRequired = (task: {
  requiresHumanReview: boolean;
  executionBriefDigest: string | null;
}): boolean => task.requiresHumanReview || task.executionBriefDigest !== null;

export const AMUX_REVIEW_PR_NUMBER_MAX = 2_147_483_647;

/**
 * A review PR number belongs only to a succeeded attempt that asks for review.
 * Any other settlement carrying one is refused, so a number can never be
 * attached to a failed or blocked card.
 */
export const amuxReviewPrNumberAccepted = (input: {
  outcome: string;
  toStatus: string;
  reviewPrNumber: number | null | undefined;
}): boolean => {
  if (input.reviewPrNumber === null || input.reviewPrNumber === undefined) return true;
  return (
    input.outcome === "succeeded" &&
    input.toStatus === "review" &&
    Number.isInteger(input.reviewPrNumber) &&
    input.reviewPrNumber >= 1 &&
    input.reviewPrNumber <= AMUX_REVIEW_PR_NUMBER_MAX
  );
};
