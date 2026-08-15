/**
 * Pure flag semantics for assistant profiles (Release C).
 *
 * docs/policy/external-conversation-import-and-memory.md §15.
 *
 * Two flags, in the externalImportAccess / memoryAccess mould: default OFF,
 * enabled only by an explicit AppSetting opt-in row, missing or malformed
 * configuration fails closed.
 *
 * They are separate because §15 activates them separately, in order —
 * profiles before knowledge. A profile with instructions and a model is
 * useful on its own; knowledge adds durable file storage, R2 objects and a
 * quota, and turning that on is its own decision. `assistantKnowledgeEnabled`
 * therefore only means anything while profiles are on, which
 * `assistantKnowledgeUsable()` states so no caller has to remember it.
 */

export const ASSISTANT_PROFILES_FLAG_KEY = "feature.assistantProfilesEnabled";
export const ASSISTANT_KNOWLEDGE_FLAG_KEY = "feature.assistantKnowledgeEnabled";

export function assistantProfilesEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}

export function assistantKnowledgeEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}

/**
 * Whether knowledge is actually usable, which is both flags and not one.
 *
 * Knowledge only exists attached to a profile. With profiles off, an enabled
 * knowledge flag would otherwise describe upload endpoints for something the
 * user cannot reach — a state that reads as enabled in the admin console and
 * is inert in the product.
 */
export function assistantKnowledgeUsable(input: {
    profilesEnabled: boolean;
    knowledgeEnabled: boolean;
}): boolean {
    return input.profilesEnabled && input.knowledgeEnabled;
}
