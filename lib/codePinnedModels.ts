/**
 * Models the code calls by a fixed id, which the Admin registry must therefore
 * not switch off or remove.
 *
 * 2026-11-11: gpt-5-6-luna was disabled in Admin. The Prompt Refiner price pin
 * names it, the Chat release readiness check reads the pinned model's state,
 * and Chat closed for every account with no error logged. The registry could
 * not know the code depended on that row. This list is how it knows.
 *
 * Read from the constants themselves, so moving a pin moves the protection with
 * it. Add an entry whenever code requires a specific model id to be enabled.
 */
import { PROMPT_REFINER_EXECUTION_MODEL_PIN } from "@/lib/promptRefinerExecutionContract";
import { PROMPT_REFINER_VNEXT_PRICE_PIN } from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

export type CodePinnedModel = Readonly<{ modelId: string; pinnedBy: string }>;

export const CODE_PINNED_MODELS: readonly CodePinnedModel[] = Object.freeze([
    {
        modelId: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId,
        pinnedBy: "the Prompt Refiner price pin (Chat release readiness depends on it)",
    },
    {
        modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
        pinnedBy: "the Prompt Refiner execution contract",
    },
]);

/**
 * Why this registry change must be refused, or null.
 *
 * The price readback that gates Chat refuses a pinned row that is not enabled,
 * not public, remapped to a replacement, or priced from registry columns
 * instead of the code catalogue (lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts).
 * Each of those is refused here. Everything else -- name, purpose, sort order --
 * stays editable. Move the pin in code first.
 */
export const codePinnedModelRefusal = (input: {
    modelId: string;
    status?: string;
    catalogDeleted?: boolean;
    publiclyListed?: boolean;
    replacementModelId?: string | null;
    inputUsdPerMillionTokens?: number | null;
    outputUsdPerMillionTokens?: number | null;
    cachedInputPriceMultiplier?: number | null;
}): string | null => {
    const pins = CODE_PINNED_MODELS.filter((pin) => pin.modelId === input.modelId);
    if (pins.length === 0) return null;
    const change =
        input.catalogDeleted === true
            ? "removing it from the catalogue"
            : input.status !== undefined && input.status !== "enabled"
              ? "changing its status"
              : input.publiclyListed === false
                ? "unlisting it"
                : input.replacementModelId
                  ? "pointing it at a replacement"
                  : [input.inputUsdPerMillionTokens, input.outputUsdPerMillionTokens,
                     input.cachedInputPriceMultiplier].some((value) => typeof value === "number")
                    ? "overriding its price"
                    : null;
    if (!change) return null;
    const by = Array.from(new Set(pins.map((pin) => pin.pinnedBy))).join(" and ");
    return `${input.modelId} is fixed in code by ${by}; ${change} would break that path. Move the pin in code first.`;
};
