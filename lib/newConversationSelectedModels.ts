/**
 * What a brand-new conversation starts with, for every product that starts one.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.3,
 * docs/policy/default-model-luna-migration.md §1.2.
 *
 * ## Why this is a function rather than four lines repeated
 *
 * `POST /api/conversations` (and its per-product siblings) already resolved a
 * start state this way: the account's saved new-conversation combination,
 * `null` meaning `[defaultModel]`, run through the catalogue clamp so a
 * retired or plan-locked entry is dropped rather than stored. External
 * continuation now starts a Review conversation too, and §8.3 is explicit that
 * it uses *the same* rules -- "이어가기 전용 기본 조합을 두지 않습니다".
 *
 * Two call sites that each spell out the same two-step resolution are two call
 * sites that can drift, and the drift would be invisible: both would produce a
 * plausible list of models, and only one would match what the account saved.
 * So the two steps live here and both callers read them from one place.
 *
 * ## What this deliberately does not do
 *
 * It does not apply the plan's model limit. The two callers need different
 * answers to a combination that is larger than the plan allows:
 *
 *   * a create that the *user* asked for with an explicit list is refused,
 *     with `modelLimitResponse()`, because the request named models the plan
 *     does not allow;
 *   * a continuation, which names none, cannot be refused for a combination
 *     the user did not ask for in this request -- it takes the first N.
 *
 * Folding the cap in here would force one of those answers onto both. The
 * callers apply it, and `capToPlanModelLimit` below is what they use so at
 * least the truncation is spelled once.
 *
 * It also never writes. Reading a stored combination never rewrites it -- only
 * an explicit user save or an approved retirement reconciliation does
 * (docs/policy/default-model-luna-migration.md §1.2).
 */

import { clampRuntimeSelectedModels, getRuntimeModels } from "@/lib/modelRegistry";
import type { ModelTier } from "@/lib/models";
import { resolveNewConversationModels } from "@/lib/newConversationModels";

export async function resolveNewConversationSelectedModels(input: {
    /** `UserSettings.newConversationModelIds`, as stored. */
    storedNewConversationModelIds: unknown;
    /** `UserSettings.defaultModel` or the application default. */
    defaultModelId: string;
    planTier: ModelTier;
}): Promise<string[]> {
    const resolved = resolveNewConversationModels({
        stored: input.storedNewConversationModelIds ?? null,
        defaultModel: input.defaultModelId,
        models: await getRuntimeModels(),
        plan: input.planTier,
    });
    const clamped = await clampRuntimeSelectedModels(resolved.effectiveModelIds);
    // `resolveNewConversationModels` never returns an empty list, but the
    // clamp can: every model in the combination could have been delisted
    // between the save and now. The representative model is the last thing
    // standing, and a conversation with no model is one nothing can answer.
    return clamped.length > 0 ? clamped : [input.defaultModelId];
}

/**
 * The plan's ceiling, applied by taking the front of the list.
 *
 * The front rather than an arbitrary subset because the combination is
 * ordered: `effectiveModelIds[0]` is the account's representative model
 * (docs/policy/default-model-luna-migration.md §1.2), so the first N is the N
 * the account would have picked.
 */
export const capToPlanModelLimit = (
    modelIds: readonly string[],
    maxModels: number
): string[] => modelIds.slice(0, Math.max(1, maxModels));
