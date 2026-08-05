// Image generation lifecycle rules, dependency-free on purpose (no Prisma,
// no "server-only") so a fixed-clock unit test can reach every one of them.
// Persisted shapes live in prisma/schema.prisma; policy in
// docs/policy/image-generation.md.

export const IMAGE_GENERATION_STATUSES = [
  "pending",
  "processing",
  "settling",
  "succeeded",
  "failed",
] as const;

export type ImageGenerationStatus = (typeof IMAGE_GENERATION_STATUSES)[number];

export const IMAGE_GENERATION_FAILURE_PHASES = [
  "provider_moderation_rejected",
  "provider_user_error",
  "provider_rate_limited",
  "provider_failed",
  "original_storage_failed",
  "stale_job_reconciled",
] as const;

export type ImageGenerationFailurePhase =
  (typeof IMAGE_GENERATION_FAILURE_PHASES)[number];

// `settling` is reachable from both live states because it is the
// exactly-once claim: the worker settles a generation it just finished, and
// the reconciliation sweep settles one whose worker died. Whichever of the
// two wins the conditional update owns the ledger write; the loser sees zero
// updated rows and walks away. Terminal states accept no transition.
const IMAGE_GENERATION_TRANSITIONS: Record<
  ImageGenerationStatus,
  readonly ImageGenerationStatus[]
> = {
  pending: ["processing", "settling"],
  processing: ["settling"],
  settling: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export const canTransitionImageGenerationStatus = (
  from: ImageGenerationStatus,
  to: ImageGenerationStatus
): boolean => IMAGE_GENERATION_TRANSITIONS[from]?.includes(to) ?? false;

export const IMAGE_ASSET_ROLES = ["original", "thumbnail"] as const;
export type ImageAssetRole = (typeof IMAGE_ASSET_ROLES)[number];

export const IMAGE_ASSET_STATUSES = ["pending", "ready", "failed"] as const;

// R2 key namespace. `userId` is the opaque cuid, never an email hash: an
// email is mutable and an unsalted hash of it is a guessable identifier, so
// the attachment convention (sha256 of the email) is deliberately not
// reused here. The conversation segment makes every asset of a conversation
// enumerable by prefix, which is what the deletion sweep relies on.
export const IMAGE_ASSET_KEY_PREFIX = "images/";

export const imageConversationR2Prefix = (
  userId: string,
  conversationId: string
) => `${IMAGE_ASSET_KEY_PREFIX}${userId}/${conversationId}/`;

export const imageAssetR2Key = (input: {
  userId: string;
  conversationId: string;
  generationId: string;
  role: ImageAssetRole;
}) =>
  `${imageConversationR2Prefix(input.userId, input.conversationId)}${input.generationId}/${
    input.role === "original" ? "original.png" : "thumb.webp"
  }`;

// A generation still pending/processing/settling after this long has lost
// its worker. Worst legitimate run is bounded: at most three provider
// attempts of ~2 minutes each plus ~4s of backoff (imageProviderAdapter),
// plus storage and thumbnail derivation -- under 8 minutes end to end; 12
// keeps a comfortable margin. Reclaiming earlier matters because the v1
// executor dies with its process on a redeploy (observed on staging during
// the beta rollout), and this window plus the 15-minute sweep cadence is
// exactly how long a user waits for the automatic refund. Correctness does
// not depend on the value: the `settling` claim is exactly-once, so a
// pathologically slow worker that finishes after the sweep reclaimed its row
// simply loses the claim and discards the result.
export const STALE_IMAGE_GENERATION_AFTER_MS = 12 * 60 * 1_000;

export const IMAGE_ASSET_CLEANUP_REASONS = [
  "conversation_deleted",
  "account_deleted",
  "storage_rollback",
] as const;

export type ImageAssetCleanupReason =
  (typeof IMAGE_ASSET_CLEANUP_REASONS)[number];

// Cleanup rows past this many attempts stop being retried by the sweep and
// surface as an admin metric instead: a key that failed this often needs an
// operator, not attempt one hundred.
export const IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS = 10;

// Group state is never stored (policy §11): it derives from each target's
// CURRENT attempt only. Passing every attempt would let an already-retried
// failure drag the derivation backwards -- callers must pass exactly one
// status per target.
export const IMAGE_GROUP_STATUSES = [
  "in_progress",
  "succeeded",
  "partial_success",
  "failed",
] as const;

export type ImageGroupStatus = (typeof IMAGE_GROUP_STATUSES)[number];

const isTerminalGenerationStatus = (status: ImageGenerationStatus) =>
  status === "succeeded" || status === "failed";

export const deriveImageGroupStatus = (
  currentAttemptStatuses: readonly ImageGenerationStatus[]
): ImageGroupStatus => {
  if (currentAttemptStatuses.length === 0) {
    // A group with no targets violates the creation invariant; report the
    // most conservative live state rather than inventing a terminal one.
    return "in_progress";
  }
  if (
    currentAttemptStatuses.some((status) => !isTerminalGenerationStatus(status))
  ) {
    return "in_progress";
  }
  const succeeded = currentAttemptStatuses.filter(
    (status) => status === "succeeded"
  ).length;
  if (succeeded === currentAttemptStatuses.length) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial_success";
};

/**
 * Which of a target's attempts is its current state.
 *
 * `deriveImageGroupStatus` above refuses to be handed every attempt, which
 * leaves each caller to pick the right one by hand -- and picking wrong is
 * invisible: a group whose failed attempt was already retried would report
 * `partial_success` while the retry is still running. The rule lives here so
 * there is one of it.
 *
 * `currentGenerationId` is authoritative; it moves to the new attempt in the
 * same transaction that creates it. The highest attempt number is the fallback
 * for the window where a row exists and the pointer has not been read yet, and
 * for a v1 row backfilled without one.
 */
export const currentImageAttempt = <
  T extends { id: string; attemptNumber: number },
>(target: {
  currentGenerationId: string | null;
  generations: readonly T[];
}): T | null => {
  if (target.generations.length === 0) return null;
  const byPointer = target.generations.find(
    (generation) => generation.id === target.currentGenerationId
  );
  if (byPointer) return byPointer;
  return target.generations.reduce((newest, generation) =>
    generation.attemptNumber >= newest.attemptNumber ? generation : newest
  );
};

/** `deriveImageGroupStatus` over whole targets, current attempt picked here. */
export const deriveImageGroupStatusFromTargets = (
  targets: readonly {
    currentGenerationId: string | null;
    generations: readonly {
      id: string;
      attemptNumber: number;
      status: ImageGenerationStatus;
    }[];
  }[]
): ImageGroupStatus =>
  deriveImageGroupStatus(
    targets
      .map((target) => currentImageAttempt(target))
      .filter((attempt) => attempt !== null)
      .map((attempt) => attempt.status)
  );
