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
import {
    PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_PRODUCT_PRICE_PIN,
} from "@/lib/promptRefinerProductPricePin";

export type CodePinnedModel = Readonly<{
    modelId: string;
    provider: string;
    apiModelId: string;
    /** The output cap and reservation the pin's contract needs at least. */
    minOutputTokens: number;
    pinnedBy: string;
}>;

/**
 * Only pins a live product path depends on. The vNext evaluation pin and the v1
 * shadow execution pin (both gpt-5-6-luna) are evaluation records used by
 * owner-only Admin routes, which fail closed on their own when the model goes;
 * listing them would stop that model from ever retiring.
 */
export const CODE_PINNED_MODELS: readonly CodePinnedModel[] = Object.freeze([
    {
        modelId: PROMPT_REFINER_PRODUCT_PRICE_PIN.modelId,
        provider: PROMPT_REFINER_PRODUCT_PRICE_PIN.provider,
        apiModelId: PROMPT_REFINER_PRODUCT_PRICE_PIN.apiModelId,
        minOutputTokens: PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
        pinnedBy: "the Prompt Refiner product price pin (Chat release readiness depends on it)",
    },
]);

/**
 * Why this registry change must be refused, or null.
 *
 * The price readback that gates Chat refuses a pinned row that is not enabled,
 * not public, remapped to a replacement, priced from registry columns instead
 * of the code catalogue, pointed at another provider or upstream id, or capped
 * below the contract's output tokens
 * (lib/promptRefinerProductPriceReadback.ts). Each of
 * those is refused here, against the values the save would leave. Everything
 * else -- name, purpose, sort order -- stays editable. Move the pin in code
 * first.
 */
export const codePinnedModelRefusal = (input: {
    modelId: string;
    status?: string;
    catalogDeleted?: boolean;
    publiclyListed?: boolean;
    provider?: string;
    apiModel?: string;
    maxOutputTokens?: number | null;
    reservationOutputTokens?: number | null;
    replacementModelId?: string | null;
    inputUsdPerMillionTokens?: number | null;
    outputUsdPerMillionTokens?: number | null;
    cachedInputPriceMultiplier?: number | null;
}): string | null => {
    const pins = CODE_PINNED_MODELS.filter((pin) => pin.modelId === input.modelId);
    if (pins.length === 0) return null;
    const belowCap = (value: number | null | undefined) =>
        typeof value === "number" && pins.some((pin) => value < pin.minOutputTokens);
    const change =
        input.catalogDeleted === true
            ? "removing it from the catalogue"
            : input.status !== undefined && input.status !== "enabled"
              ? "changing its status"
              : input.publiclyListed === false
                ? "unlisting it"
                : input.replacementModelId
                  ? "pointing it at a replacement"
                  : (input.provider !== undefined && pins.some((pin) => pin.provider !== input.provider)) ||
                      (input.apiModel !== undefined && pins.some((pin) => pin.apiModelId !== input.apiModel))
                    ? "changing its provider or upstream model id"
                  : belowCap(input.maxOutputTokens) || belowCap(input.reservationOutputTokens)
                    ? "capping its output below the contract"
                  : [input.inputUsdPerMillionTokens, input.outputUsdPerMillionTokens,
                     input.cachedInputPriceMultiplier].some((value) => typeof value === "number")
                    ? "overriding its price"
                    : null;
    if (!change) return null;
    const by = Array.from(new Set(pins.map((pin) => pin.pinnedBy))).join(" and ");
    return `${input.modelId} is fixed in code by ${by}; ${change} would break that path. Move the pin in code first.`;
};
