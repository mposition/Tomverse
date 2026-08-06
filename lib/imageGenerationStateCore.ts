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
  // The provider succeeded and the *settlement* did not. Kept apart from
  // `provider_failed` because the two are different operational problems:
  // one says the image never arrived, this one says it arrived and the ledger
  // write for it was lost. Reading the second as the first would send an
  // operator to the provider's status page.
  "settlement_failed",
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

// How long one provider call may take before it is aborted, and the jittered
// backoff between the initial attempt and its two retries. Owned here rather
// than in the adapter because three separate deadlines are derived from them
// -- the stale threshold below, the post-response executor's budget, and the
// route budget that executor runs inside -- and a change to either number has
// to move all three or the sweep starts refunding live work.
export const IMAGE_PROVIDER_TIMEOUT_MS = 150_000;
export const IMAGE_PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000] as const;

// Downloading the result, deriving the thumbnail and writing both to R2. Not
// measured from a provider deadline, so it is a stated allowance rather than
// a derived figure.
const IMAGE_STORAGE_ALLOWANCE_MS = 30_000;

/** The worst legitimate end-to-end time for one image attempt. */
export const IMAGE_ATTEMPT_WORST_CASE_MS =
  (IMAGE_PROVIDER_RETRY_DELAYS_MS.length + 1) * IMAGE_PROVIDER_TIMEOUT_MS +
  IMAGE_PROVIDER_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) +
  IMAGE_STORAGE_ALLOWANCE_MS;

// A generation still pending/processing/settling after this long has lost
// its worker. The worst legitimate run above is a little over eight minutes,
// so 12 keeps a comfortable margin -- and the margin is the point: a
// threshold at or below `IMAGE_ATTEMPT_WORST_CASE_MS` would have the sweep
// refunding work that is still running. Reclaiming earlier matters because
// the v1 executor dies with its process on a redeploy (observed on staging
// during the beta rollout), and this window plus the 15-minute sweep cadence
// is exactly how long a user waits for the automatic refund. Correctness does
// not depend on the value: the `settling` claim is exactly-once, so a
// pathologically slow worker that finishes after the sweep reclaimed its row
// simply loses the claim and discards the result.
export const STALE_IMAGE_GENERATION_AFTER_MS = 12 * 60 * 1_000;

// The largest group the service will admit, and the smallest per-provider job
// cap it will run one with (lib/imageGenerationService.ts bounds both). A
// group whose targets all sit on one provider therefore runs in at most two
// serial rounds, which is what the executor's budget has to cover.
const IMAGE_GROUP_MAX_MODELS_CEILING = 4;
const IMAGE_PROVIDER_JOB_LIMIT_FLOOR = 2;

/**
 * How long the post-response executor may need, in seconds.
 *
 * `after()` runs "for the platform's default or configured max duration of
 * your route" (next/dist/docs .../functions/after.md), so a route that drives
 * a generation group from `after()` has to state a budget at least this large
 * -- otherwise an unstated platform default decides where the executor is cut
 * off, and a cut-off executor is not a delay: nothing re-drives a `pending`
 * generation, so the sweep refunds it and the request is lost.
 */
export const IMAGE_EXECUTOR_MAX_DURATION_SECONDS = Math.ceil(
  (Math.ceil(IMAGE_GROUP_MAX_MODELS_CEILING / IMAGE_PROVIDER_JOB_LIMIT_FLOOR) *
    IMAGE_ATTEMPT_WORST_CASE_MS) /
    1_000
);

// `settling` gets its own, longer window, because reclaiming it is not the
// same act. A `pending`/`processing` row has written nothing to the ledger, so
// taking it back costs nothing; a `settling` row is one whose settlement
// transaction may still be open, and taking that one back races a credit
// write. What makes the reclaim safe is that the reservation carries its own
// `reserved -> settling` claim *inside* that transaction, so a settlement that
// already happened simply refuses the second attempt -- this window only has
// to be longer than any transaction can live, which is seconds.
//
// It exists at all because `settling` was otherwise a trap: nothing reclaimed
// it. The generation claim is made *outside* the settlement transaction, so a
// rollback -- a deadlock, a lost connection, a redeploy between the two --
// left the row in `settling` with its credits still reserved, invisible to the
// recovery sweep and to the failure path, forever.
export const STALE_IMAGE_SETTLING_AFTER_MS = 15 * 60 * 1_000;

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

// Policy §9 promises the thumbnail retries in the background, because its
// failure must not demote the original. Fewer attempts than a cleanup gets:
// a cleanup retries a delete that will eventually succeed, while a thumbnail
// failure is usually sharp refusing the bytes -- deterministic, and repeating
// it forever would re-download the original on every sweep to learn the same
// answer. Past this the row stays `failed`, the card keeps rendering the
// original, and the count surfaces to an operator.
export const IMAGE_THUMBNAIL_MAX_RETRIES = 4;

// Bound on a single repair read. Generous next to any gpt-image-2 original
// (a 1536x1024 PNG is single-digit MB) and it exists so a corrupt or
// unexpectedly huge object cannot pull the maintenance process over.
export const IMAGE_ORIGINAL_MAX_READ_BYTES = 32 * 1024 * 1024;

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
