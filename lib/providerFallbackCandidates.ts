export type PublicModelStatus = "available" | "limited" | "unavailable";

/**
 * How healthy the replacements offered for an unavailable model are, judged
 * from the same status snapshot the rest of the response is built from.
 *
 * - `operational` -- at least one candidate is fully available.
 * - `degraded`    -- candidates exist, but every one of them is limited.
 * - `none`        -- nothing usable is left to offer.
 * - `unknown`     -- provider health could not be read, so the candidate is
 *                    offered without any claim about it.
 */
export type FallbackHealth = "operational" | "degraded" | "none" | "unknown";

const CANDIDATE_RANK: Record<PublicModelStatus, number> = {
  available: 0,
  limited: 1,
  unavailable: 2,
};

/**
 * RECON-OPS-001. The public model-status route used to build its replacement
 * list from the registry's static `replacementModelId` plus the provider's
 * configured recommendations, with no reference to how those candidates were
 * doing at that moment. An incident banner could therefore -- and did --
 * recommend two models whose own providers were degraded in the very same
 * snapshot, and say nothing about it.
 *
 * This decides only *which* candidates are surfaced and *in what order*. It
 * never decides a status (that stays with the caller's status pass), and it
 * never swaps a model in on the user's behalf: when nothing healthy is left
 * it returns an empty list and `none`, so the UI can say so honestly instead
 * of printing a list that reads like a safe alternative.
 */
export function selectFallbackCandidates({
  replacementModelId,
  recommendedModelIds,
  isPublicModel,
  statusOf,
}: {
  replacementModelId?: string | null;
  recommendedModelIds?: readonly string[];
  isPublicModel: (modelId: string) => boolean;
  statusOf: (modelId: string) => PublicModelStatus | undefined;
}): { fallbackModelIds: string[]; fallbackHealth: FallbackHealth } {
  const fallbackModelIds = Array.from(
    new Set([
      ...(replacementModelId ? [replacementModelId] : []),
      ...(recommendedModelIds ?? []),
    ])
  )
    // A candidate that is itself unavailable is not a replacement.
    .filter(
      (modelId) => isPublicModel(modelId) && statusOf(modelId) !== "unavailable"
    )
    .sort(
      (a, b) =>
        CANDIDATE_RANK[statusOf(a) ?? "available"] -
        CANDIDATE_RANK[statusOf(b) ?? "available"]
    );

  const fallbackHealth: FallbackHealth =
    fallbackModelIds.length === 0
      ? "none"
      : fallbackModelIds.some((modelId) => statusOf(modelId) === "available")
        ? "operational"
        : "degraded";

  return { fallbackModelIds, fallbackHealth };
}
