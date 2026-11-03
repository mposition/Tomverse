import "server-only";

import { AssistantProfileError } from "@/lib/assistantProfileService";
import {
    ASSISTANT_PROFILE_LIMITS,
    ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
} from "@/lib/assistantProfileVersioning";
import { resolveSelectableModelId } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";

/**
 * The models a profile version is published with, as the catalogue the server
 * actually serves names them.
 *
 * Each requested id is resolved through the replacement chain and the result
 * is de-duplicated, so a retired id and its successor are one model, stored
 * under the id a conversation started from the profile would run on. Found in
 * production on 2026-11-03: ticking "Claude Sonnet 5" (retired, replaced by
 * `claude-sonnet-5-5`) beside a stored `claude-sonnet-5-5` published both, and
 * Chat refused the assistant as a multi-model one.
 *
 * Dropping what cannot be resolved is right for restoring a stored
 * conversation and wrong here: a publish naming a model that does not exist
 * would silently become one naming fewer. So an id with no live model is a
 * refusal rather than a shortfall.
 *
 * Naming none stays none (`docs/policy/external-conversation-import-and-memory.md §14.0a`):
 * the conversation resolves the account's own new-conversation selection when
 * it is created.
 */
export async function resolveProfileModelIds(
    requested: readonly string[] | undefined
): Promise<string[]> {
    if (requested === undefined || requested.length === 0) return [];
    const catalogue = new Map(
        (await getRuntimeModels()).map((model) => [model.id, model])
    );
    const resolved = requested.map((modelId) =>
        resolveSelectableModelId(modelId, (candidateId) =>
            catalogue.get(candidateId)
        )
    );
    if (resolved.some((modelId) => modelId === undefined)) {
        throw new AssistantProfileError(
            422,
            ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
            "One of those models is not available."
        );
    }
    return Array.from(new Set(resolved as string[])).slice(
        0,
        ASSISTANT_PROFILE_LIMITS.maxModels
    );
}
