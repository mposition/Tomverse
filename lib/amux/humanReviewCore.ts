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
 * The review specialty a card gets when a settlement first records its PR and
 * it had none (AmuxWorkItem_human_review_shape_check pairs the flag with a
 * specialty). It matches the planning key pattern.
 */
export const AMUX_DEFAULT_REVIEW_SPECIALTY = "code-review";

/**
 * Reason codes the WSL runner sends with a settlement (policy version 15).
 * Only these are stored; any other text a caller sends is ignored.
 */
export const AMUX_BRIDGE_SETTLE_REASONS = [
  "local_card_done",
  "local_card_closed",
  "local_card_unlinked",
  "local_card_ambiguous",
] as const;

export type AmuxBridgeSettleReason = (typeof AMUX_BRIDGE_SETTLE_REASONS)[number];

export const amuxBridgeSettleReason = (
  reason: string | null | undefined,
): AmuxBridgeSettleReason | null =>
  (AMUX_BRIDGE_SETTLE_REASONS as readonly string[]).includes(reason ?? "")
    ? (reason as AmuxBridgeSettleReason)
    : null;

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
