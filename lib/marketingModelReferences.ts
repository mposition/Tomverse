// Models that public marketing pages name by hand.
//
// Marketing copy is the one surface that talks about specific models outside
// the catalogue's own rendering: a landing page picks a pair, writes prose and
// badges around them, deep-links a prepared comparison, and quotes example
// answers those exact models produced. None of that follows a model's
// lifecycle automatically -- retire a model and the page keeps advertising it,
// and its "compare these two" link starts pointing at something the picker
// will silently resolve elsewhere.
//
// So the ids live here, in one list, and `tests/marketingModelReferences.test.mjs`
// asserts every one of them is still publicly selectable. That check turns
// "remember to update marketing" into a failing test at exactly the moment a
// referenced model is disabled or delisted.
//
// This list is about *ids*. The surrounding copy, badges, result labels,
// structured data and captured screenshots are listed in
// docs/policy/default-model-luna-migration.md and have to move with it -- a
// referenced model cannot be swapped by editing this array alone.

import { getModel, isPubliclySelectableModel, type AiModel } from "@/lib/models";

/**
 * The pair the /chatgpt-vs-claude guide compares, badges, quotes example
 * answers from, and pre-selects in its "compare these two" deep link.
 * Consumed by components/marketing/ChatGptVsClaudeGuide.tsx.
 */
export const CHATGPT_VS_CLAUDE_MODEL_IDS = [
    "gpt-5-4-mini",
    "claude-haiku-4-5",
] as const;

/** Every model id a public marketing page names. */
export const MARKETING_REFERENCED_MODEL_IDS: readonly string[] = Array.from(
    new Set<string>([...CHATGPT_VS_CLAUDE_MODEL_IDS])
);

export type UnsellableMarketingModel = {
    modelId: string;
    reason: "unknown_model" | "not_publicly_selectable";
};

/**
 * Marketing-referenced ids that the catalogue will not let a visitor select.
 *
 * Empty is the only acceptable state: a marketing page that advertises a model
 * nobody can pick is a broken promise, and its prepared comparison link would
 * quietly resolve to a different model than the one the page describes.
 */
export const findUnsellableMarketingModels = (
    lookup: (modelId: string) => AiModel | undefined = getModel
): UnsellableMarketingModel[] =>
    MARKETING_REFERENCED_MODEL_IDS.flatMap<UnsellableMarketingModel>(
        (modelId) => {
            const model = lookup(modelId);
            if (!model) return [{ modelId, reason: "unknown_model" }];
            if (!isPubliclySelectableModel(model)) {
                return [{ modelId, reason: "not_publicly_selectable" }];
            }
            return [];
        }
    );
