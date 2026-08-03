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
// its worker: the concurrency lease tops out at 30 minutes
// (MAX_LEASE_TTL_SECONDS) and a healthy provider call finishes in ~2, so
// nothing legitimate is still live at 45. The reconciliation sweep claims
// these via `settling` and refunds them (refund wiring lands with the
// billing PR).
export const STALE_IMAGE_GENERATION_AFTER_MS = 45 * 60 * 1_000;

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
