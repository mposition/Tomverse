/**
 * The single interpreter for a signed-in account's "new conversation default
 * combination" (`UserSettings.newConversationModelIds`, nullable JSON).
 *
 * This is the third default-model decision, next to the guest lead model and
 * the platform/account representative model -- see
 * docs/policy/default-model-luna-migration.md §1.2. Every route and client
 * path that needs the combination goes through these functions; none of them
 * re-implements the fallback.
 *
 * Contract highlights:
 *
 *   * `null` (DB NULL and JSON null alike) means `[defaultModel]`. Existing
 *     accounts keep their single-model behaviour without a backfill.
 *   * Reading NEVER rewrites anything. `resolveNewConversationModels` splits
 *     the stored combination from the effective one and reports machine
 *     reason codes; persisting a change is only ever an explicit user save or
 *     an approved retirement reconciliation.
 *   * Replacement follows the same mutable-selection lifecycle as everything
 *     else (`resolveSelectableModelId`): enabled, status "enabled", publicly
 *     listed, not catalog-deleted -- and the account's plan must have access.
 *     Nothing is auto-upgraded to a dearer model or a higher plan.
 *
 * Kept pure and injected (the caller supplies the catalogue) so the same
 * rules apply to the runtime registry, the compiled catalogue and a fixture
 * in a unit test.
 */

import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
    canUseModelWithPlan,
    resolveSelectableModelId,
    type AiModel,
    type ModelTier,
} from "@/lib/models";

export const NEW_CONVERSATION_MODELS_MAX = 3;

export type NewConversationModelsReasonCode =
    /** The stored JSON was not a 1-3 string array; treated as unset. */
    | "stored_value_malformed"
    /** Duplicate ids were collapsed while reading. */
    | "duplicates_removed"
    /** More than the maximum were stored; the tail was ignored. */
    | "over_limit_truncated"
    /** A stored model resolved to its replacement. */
    | "model_replaced"
    /** A stored model no longer resolves to anything selectable. */
    | "model_unavailable"
    /** A stored model is not accessible on the account's plan. */
    | "model_plan_locked"
    /** Nothing stored survived; the combination fell back to the lead. */
    | "fallback_to_default_model"
    /** The representative model itself resolved to a replacement. */
    | "default_model_replaced"
    /** Stored defaultModel and the stored combination lead disagree. */
    | "default_model_out_of_sync";

export type ResolvedNewConversationModels = {
    /** The stored combination as parsed, or null when unset/malformed. */
    storedModelIds: string[] | null;
    /** What a new conversation actually starts with. Never empty. */
    effectiveModelIds: string[];
    /** The effective representative model: always effectiveModelIds[0]. */
    effectiveDefaultModelId: string;
    /**
     * True when the user-visible start state differs from what they saved
     * (a model was dropped, replaced or the whole combination fell back).
     * Pure diagnostics (dedupe, lead-sync drift) do not set it.
     */
    changed: boolean;
    reasons: NewConversationModelsReasonCode[];
};

export type ParsedStoredNewConversationModelIds = {
    modelIds: string[] | null;
    malformed: boolean;
};

/**
 * Defensive parse of the raw column value. Prisma hands DB NULL and JSON null
 * to us identically as `null`; `undefined` covers callers that never selected
 * the column. Anything that is not an array of 1..MAX non-empty strings is
 * malformed and treated as unset (the caller falls back to [defaultModel])
 * rather than trusted partially or destroyed.
 */
export const parseStoredNewConversationModelIds = (
    raw: unknown
): ParsedStoredNewConversationModelIds => {
    if (raw === null || raw === undefined) {
        return { modelIds: null, malformed: false };
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        return { modelIds: null, malformed: true };
    }
    const modelIds: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            return { modelIds: null, malformed: true };
        }
        modelIds.push(entry.trim());
    }
    return { modelIds, malformed: false };
};

const isSelectableNow = (model: AiModel | undefined): model is AiModel =>
    Boolean(
        model &&
            model.enabled &&
            model.status === "enabled" &&
            model.publiclyListed !== false &&
            !model.catalogDeleted
    );

export type ResolveNewConversationModelsInput = {
    /** Raw UserSettings.newConversationModelIds column value. */
    stored: unknown;
    /** Raw UserSettings.defaultModel column value. */
    defaultModel: string;
    /** The catalogue to resolve against (runtime rows or compiled). */
    models: readonly AiModel[];
    /** The account's effective plan tier. */
    plan: ModelTier | "Guest";
};

/**
 * Read-side resolution. Pure: never touches storage, never mutates input.
 */
export const resolveNewConversationModels = (
    input: ResolveNewConversationModelsInput
): ResolvedNewConversationModels => {
    const byId = new Map(input.models.map((model) => [model.id, model]));
    const lookup = (modelId: string) => byId.get(modelId);
    const reasons: NewConversationModelsReasonCode[] = [];
    let changed = false;

    const resolveForPlan = (modelId: string): string | undefined => {
        const resolvedId = resolveSelectableModelId(modelId, lookup);
        if (!resolvedId) return undefined;
        const model = lookup(resolvedId);
        if (!model || !canUseModelWithPlan(input.plan, model)) return undefined;
        return resolvedId;
    };

    // The representative model the combination falls back to. If it no longer
    // resolves (or its replacement is plan-locked), the compiled default is
    // the last resort -- the same terminal fallback the settings route used
    // before the read path stopped rewriting.
    let fallbackLead = resolveForPlan(input.defaultModel);
    let defaultModelReplaced = false;
    if (!fallbackLead) {
        fallbackLead = APP_DEFAULTS.defaultModelId;
        defaultModelReplaced = true;
    } else if (fallbackLead !== input.defaultModel) {
        defaultModelReplaced = true;
    }

    const parsed = parseStoredNewConversationModelIds(input.stored);
    if (parsed.malformed) {
        reasons.push("stored_value_malformed");
    }

    if (parsed.modelIds === null) {
        // Unset (or unusable) column: the combination IS [defaultModel].
        if (defaultModelReplaced) {
            reasons.push("default_model_replaced");
            changed = true;
        }
        return {
            storedModelIds: null,
            effectiveModelIds: [fallbackLead],
            effectiveDefaultModelId: fallbackLead,
            changed,
            reasons,
        };
    }

    const deduped = Array.from(new Set(parsed.modelIds));
    if (deduped.length !== parsed.modelIds.length) {
        reasons.push("duplicates_removed");
    }
    let candidates = deduped;
    if (candidates.length > NEW_CONVERSATION_MODELS_MAX) {
        candidates = candidates.slice(0, NEW_CONVERSATION_MODELS_MAX);
        reasons.push("over_limit_truncated");
        changed = true;
    }

    const effective: string[] = [];
    for (const modelId of candidates) {
        const resolvedId = resolveSelectableModelId(modelId, lookup);
        if (!resolvedId) {
            reasons.push("model_unavailable");
            changed = true;
            continue;
        }
        const model = lookup(resolvedId);
        if (!model || !canUseModelWithPlan(input.plan, model)) {
            reasons.push("model_plan_locked");
            changed = true;
            continue;
        }
        if (resolvedId !== modelId) {
            reasons.push("model_replaced");
            changed = true;
        }
        if (!effective.includes(resolvedId)) {
            effective.push(resolvedId);
        }
    }

    if (effective.length === 0) {
        reasons.push("fallback_to_default_model");
        changed = true;
        if (defaultModelReplaced) reasons.push("default_model_replaced");
        return {
            storedModelIds: parsed.modelIds,
            effectiveModelIds: [fallbackLead],
            effectiveDefaultModelId: fallbackLead,
            changed,
            reasons,
        };
    }

    // Read precedence: the combination's lead IS the effective representative
    // model. A drifted defaultModel column is diagnosed, never rewritten here.
    if (effective[0] === parsed.modelIds[0] && effective[0] !== input.defaultModel) {
        reasons.push("default_model_out_of_sync");
    }

    return {
        storedModelIds: parsed.modelIds,
        effectiveModelIds: effective,
        effectiveDefaultModelId: effective[0],
        changed,
        reasons,
    };
};

export type NewConversationModelsWriteRejection =
    | "empty"
    | "invalid_entry"
    | "duplicate_model"
    | "too_many_models"
    | "model_not_selectable"
    | "model_plan_locked";

export type NormalizedNewConversationModelsWrite =
    | { ok: true; modelIds: string[] }
    | {
          ok: false;
          rejection: NewConversationModelsWriteRejection;
          modelId?: string;
      };

/**
 * Write-side validation for an EXPLICIT combination save. Stricter than the
 * read side on purpose: a save must name models that are selectable right
 * now on the account's plan -- it is not the place where replacement chains
 * or silent truncation apply. The read side stays lenient so a combination
 * that was valid when saved keeps producing a usable start state later.
 */
export const normalizeNewConversationModelIdsForWrite = (input: {
    requested: readonly unknown[];
    models: readonly AiModel[];
    plan: ModelTier | "Guest";
}): NormalizedNewConversationModelsWrite => {
    if (!Array.isArray(input.requested) || input.requested.length === 0) {
        return { ok: false, rejection: "empty" };
    }
    if (input.requested.length > NEW_CONVERSATION_MODELS_MAX) {
        return { ok: false, rejection: "too_many_models" };
    }
    const byId = new Map(input.models.map((model) => [model.id, model]));
    const modelIds: string[] = [];
    for (const entry of input.requested) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            return { ok: false, rejection: "invalid_entry" };
        }
        const modelId = entry.trim();
        if (modelIds.includes(modelId)) {
            return { ok: false, rejection: "duplicate_model", modelId };
        }
        const model = byId.get(modelId);
        if (!isSelectableNow(model)) {
            return { ok: false, rejection: "model_not_selectable", modelId };
        }
        if (!canUseModelWithPlan(input.plan, model)) {
            return { ok: false, rejection: "model_plan_locked", modelId };
        }
        modelIds.push(modelId);
    }
    return { ok: true, modelIds };
};

/**
 * Legacy write sync: a client that only sends a new `defaultModel` moves that
 * model to the front of the existing combination, keeps the remaining order,
 * dedupes, and keeps at most the maximum -- dropping the LAST item on
 * overflow. With no existing combination the result is just [lead].
 */
export const moveCombinationLead = (
    existing: readonly string[] | null,
    lead: string,
    maximum = NEW_CONVERSATION_MODELS_MAX
): string[] => {
    const rest = (existing ?? []).filter((modelId) => modelId !== lead);
    return [lead, ...rest].slice(0, Math.max(1, maximum));
};
