import "server-only";

import type { Prisma } from "@prisma/client";
import { registryRowToModel } from "./modelRegistry";
import { resolveModelPricing } from "./modelPricing";
import {
    PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
    PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_VNEXT_PRICE_PIN,
} from "./promptRefinerQualityEvaluationVnextExecutionContract";

type PriceTransaction = Pick<Prisma.TransactionClient, "$executeRaw" | "modelRegistryEntry">;

/**
 * One small, read-only part of operational admission. The caller supplies the
 * app's transaction, not model or price facts. A matching registry price does
 * not attest the provider's current published rate or permit dispatch.
 */
export async function readPromptRefinerVnextOneShotPrice(transaction: PriceTransaction) {
    let row: Awaited<ReturnType<PriceTransaction["modelRegistryEntry"]["findUnique"]>>;
    try {
        // Keep the price row (including an absent row) stable until the
        // caller's transaction commits. A future admission caller must lock
        // its stage before invoking this read, then lock reservation rows.
        await transaction.$executeRaw`LOCK TABLE "ModelRegistryEntry" IN SHARE MODE`;
        row = await transaction.modelRegistryEntry.findUnique({
            where: { id: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId },
        });
    } catch {
        throw new Error("vnext_one_shot_price_read_failed");
    }
    const problems: string[] = [];
    if (!row) {
        problems.push("model_registry_row_missing");
    } else {
        try {
            const model = registryRowToModel(row);
            if (!model.enabled || model.catalogDeleted || model.status !== "enabled") {
                problems.push("model_not_enabled");
            }
            if (model.publiclyListed === false) problems.push("model_not_public");
            if (model.replacementModelId) problems.push("model_remapped");
            const price = resolveModelPricing(model, {
                estimatedPromptTokens: PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
            });
            const pin = PROMPT_REFINER_VNEXT_PRICE_PIN;
            if ((row.maxOutputTokens !== null &&
                row.maxOutputTokens < PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS) ||
                price.maxOutputTokens < PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS) {
                problems.push("output_cap_below_contract");
            }
            if ((row.reservationOutputTokens !== null &&
                row.reservationOutputTokens < PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS) ||
                price.reservationOutputTokens < PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS) {
                problems.push("reservation_output_below_contract");
            }
            if (model.id !== pin.modelId || model.provider !== pin.provider ||
                model.apiModel !== pin.apiModelId ||
                price.modelId !== pin.modelId || price.provider !== pin.provider ||
                price.apiModelId !== pin.apiModelId ||
                price.routing !== pin.routing ||
                price.processingTier !== pin.processingTier ||
                price.inputUsdPerMillionTokens !== pin.inputUsdPerMillionTokens ||
                price.cachedInputPriceMultiplier !== pin.cachedInputPriceMultiplier ||
                price.cacheWriteUsdPerMillionTokens !== pin.cacheWriteUsdPerMillionTokens ||
                price.outputUsdPerMillionTokens !== pin.outputUsdPerMillionTokens ||
                price.reasoningTokenBilling !== "billed_as_output" ||
                price.costSource !== "registry") {
                problems.push("price_pin_mismatch");
            }
        } catch {
            problems.push("model_registry_row_invalid");
        }
    }
    return Object.freeze({
        pricePinMatchesRegistry: problems.length === 0,
        providerPriceObserved: false as const,
        dispatchAuthorized: false as const,
        problems: Object.freeze(problems),
    });
}
