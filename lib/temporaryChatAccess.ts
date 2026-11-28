/**
 * Temporary Chat: a Chat conversation that stays out of the conversation list
 * and search, never reads or writes memory, cannot be shared, moved into a
 * project or exported, gets no generated title, and is deleted when the
 * person leaves it or 24 hours after it started. Personal instructions and
 * credits apply exactly as in any other Chat.
 *
 * Pure and dependency-free: the create handler, the conversation routes, the
 * sweep and the tests all read these rules.
 *
 * ## The rollout switch
 *
 * `feature.temporaryChatEnabled` in AppSetting, default off like every other
 * `feature.*` flag: only the literal "true" offers it. The switch governs
 * whether a *new* temporary Chat can be started. Turning it off never keeps an
 * existing one alive: the sweep runs regardless, because a promise to delete
 * outlives the switch that made it.
 *
 * ## What marks a conversation as temporary
 *
 * `Conversation.temporaryExpiresAt`, set by the create handler and never
 * written again. The sweep selects on it alone; a conversation where it is
 * NULL -- every ordinary conversation -- cannot be chosen. It waits, for a
 * bounded time, for work still running in the conversation (a durable answer,
 * a Research run, an image generation): see TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS.
 */

export const TEMPORARY_CHAT_FLAG_KEY = "feature.temporaryChatEnabled";

/** Only the literal "true" enables. */
export const temporaryChatEnabledFromValue = (value: string | null | undefined): boolean => value === "true";

/** How long a temporary Chat lives after it was started. */
export const TEMPORARY_CHAT_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How long past its expiry the sweep waits before deleting.
 *
 * The send path refuses a new answer from the moment of expiry, so the only
 * answers still running afterwards are ones admitted just before it. Each of
 * them holds a live durable-attempt lease (at most five minutes, renewed by
 * its checkpoints) and the sweep skips a conversation with a live lease, so
 * this margin only has to cover a turn that was admitted but had not claimed
 * its attempt yet.
 */
export const TEMPORARY_CHAT_SWEEP_GRACE_MS = 10 * 60 * 1_000;

/**
 * How long past its expiry the sweep may keep waiting for work that is still
 * running in the conversation.
 *
 * The sweep skips a conversation while a Research run is executing or an
 * image is still being generated in it: both rows cascade with the
 * conversation, so deleting underneath them throws away paid work in flight
 * and leaves the provider call to settle against nothing. The wait is a
 * deferral, never a reprieve -- the deletion promise (24 hours, plus the grace
 * above) still holds, stretched by at most this much, and a run that is
 * still "executing" past it is treated as stuck and deleted with the
 * conversation. Seven hours is the longest Research profile's own deadline
 * (six hours) plus a margin.
 */
export const TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS = 7 * 60 * 60 * 1_000;

/** Whether the sweep may still wait for running work in a conversation that expired at `temporaryExpiresAt`. */
export const temporarySweepMayDefer = (temporaryExpiresAt: Date, now: Date): boolean =>
    now.getTime() - temporaryExpiresAt.getTime() < TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS;

/**
 * Research run statuses in which work is executing (lib/researchPreviewRunTypes.ts). Not `draft`,
 * `awaiting_input` or `paused`: those wait for the person, who has left a temporary Chat that ended.
 */
export const TEMPORARY_SWEEP_LIVE_RESEARCH_STATUSES = [
    "preparing",
    "queued",
    "running",
    "checkpointed",
    "planning",
    "finalizing",
] as const;

/** Image generation statuses with a provider call or its settlement in flight (lib/imageGenerationStateCore.ts). */
export const TEMPORARY_SWEEP_LIVE_IMAGE_STATUSES = ["pending", "processing", "settling"] as const;

export const temporaryConversationExpiresAt = (now: Date): Date =>
    new Date(now.getTime() + TEMPORARY_CHAT_TTL_MS);

export const isTemporaryConversation = (temporaryExpiresAt: Date | null | undefined): boolean =>
    temporaryExpiresAt instanceof Date;

/** A temporary Chat past its expiry takes no new answer. */
export const isTemporaryConversationExpired = (
    temporaryExpiresAt: Date | null | undefined,
    now: Date
): boolean => temporaryExpiresAt instanceof Date && temporaryExpiresAt.getTime() <= now.getTime();

/** The newest expiry the sweep may delete at `now`. */
export const temporarySweepCutoff = (now: Date): Date =>
    new Date(now.getTime() - TEMPORARY_CHAT_SWEEP_GRACE_MS);

/**
 * The sweep's selection. The only predicate is the temporary marker and its
 * expiry: a conversation whose `temporaryExpiresAt` is NULL never matches,
 * whatever its age, owner or contents. `not: null` is stated even though
 * `lte` already excludes NULL in SQL, so the intent survives a later edit of
 * the comparison.
 */
export const temporaryConversationSweepWhere = (cutoff: Date) => ({
    temporaryExpiresAt: { not: null, lte: cutoff },
});

/**
 * The rows one deletion may touch: the owner's, by id, and -- when the sweep
 * deletes -- only expired temporary ones. lib/conversationDeletion.ts reads
 * the ids again through this scope inside the deleting transaction and
 * deletes through it, so an id that is not a temporary conversation drops out
 * before any of its files are queued for deletion.
 */
export const conversationDeletionScope = (input: {
    userId: string;
    conversationIds: readonly string[];
    temporaryExpiredBefore?: Date;
}) => ({
    userId: input.userId,
    id: { in: [...new Set(input.conversationIds)] },
    ...(input.temporaryExpiredBefore
        ? temporaryConversationSweepWhere(input.temporaryExpiredBefore)
        : {}),
});

export const TEMPORARY_CHAT_EXPIRED = "TEMPORARY_CHAT_EXPIRED";
export const TEMPORARY_CHAT_UNAVAILABLE = "TEMPORARY_CHAT_UNAVAILABLE";
export const TEMPORARY_CHAT_NOT_ALLOWED = "TEMPORARY_CHAT_NOT_ALLOWED";

/**
 * Which conversation update a temporary Chat refuses. Moving it into a
 * project or turning its memory on would undo two of its promises; the
 * database refuses both as well (Conversation_temporary_scope_check), and this
 * answers with a 409 the screen can explain instead of a failed write.
 */
export function temporaryConversationUpdateRefusal(
    temporaryExpiresAt: Date | null | undefined,
    update: { projectId?: string | null; memoryMode?: string }
): typeof TEMPORARY_CHAT_NOT_ALLOWED | null {
    if (!isTemporaryConversation(temporaryExpiresAt)) return null;
    if (update.projectId !== undefined && update.projectId !== null) return TEMPORARY_CHAT_NOT_ALLOWED;
    if (update.memoryMode !== undefined && update.memoryMode !== "off") return TEMPORARY_CHAT_NOT_ALLOWED;
    return null;
}
