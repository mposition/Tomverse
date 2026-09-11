/**
 * Pure flag semantics for "Tomverse에서 이어가기" (continuation).
 *
 * Policy: docs/policy/external-conversation-continuation.md §7.
 *
 * A separate rollout flag from `feature.externalConversationImportEnabled`,
 * and separate from both memory flags. The reason is not tidiness: import is
 * already on in production, and folding continuation into it would have turned
 * a feature nobody has verified on for every account that can import. The
 * memory flags are separate for the opposite reason — continuation must work
 * with memory off, so a shared flag would make it look like a memory feature
 * and tie its rollback to one.
 *
 * Default OFF, enabled only by an explicit AppSetting opt-in row, and a
 * missing or unreadable row fails closed
 * (docs/policy/external-conversation-import-and-memory.md §15).
 *
 * Kept pure so the semantics are testable without a database, exactly like
 * `lib/externalImportAccess.ts`.
 */

export const EXTERNAL_CONTINUATION_FLAG_KEY =
    "feature.externalConversationContinuationEnabled";

export function externalContinuationEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}

/**
 * What the flag governs, and what it deliberately does not.
 *
 * docs/policy/external-conversation-continuation.md §7 splits the flag into
 * two halves because they have different blast
 * radii, and a single boolean read at one place would have made the smaller
 * half impossible to keep:
 *
 *   creation   — starting a new continuation. Fails closed.
 *   injection  — seeding a turn from the source. Fails closed.
 *   reading    — opening a conversation that already exists, and sending
 *                ordinary messages in it. NEVER gated.
 *
 * The third is the rollback contract. A user who already has a bridged
 * conversation has ordinary `Message` rows in it, and a flag that hid them
 * would take away work the feature being off has nothing to do with. Turning
 * the flag off stops new bridges and stops the seed reaching a prompt; it
 * never hides a message somebody wrote.
 */
export type ContinuationCapability = "create" | "seed";

export const CONTINUATION_FLAG_GATED_CAPABILITIES: readonly ContinuationCapability[] =
    ["create", "seed"];

/**
 * Whether a capability may run, given the flag.
 *
 * Written as an explicit switch rather than `return flagEnabled` so the
 * reading case has a name in the code: a later capability that must survive
 * a rollback is added here, not by remembering not to call this.
 */
export const continuationCapabilityAllowed = (
    capability: ContinuationCapability,
    flagEnabled: boolean
): boolean => {
    switch (capability) {
        case "create":
        case "seed":
            return flagEnabled;
        default: {
            const exhaustive: never = capability;
            return exhaustive;
        }
    }
};
