import "server-only";

import type { Prisma } from "@prisma/client";
import { registryRowToModel } from "./modelRegistry";
import { resolveModelPricing } from "./modelPricing";
import {
    PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS,
    PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_PRODUCT_PRICE_PIN,
} from "./promptRefinerProductPricePin";

type PriceTransaction = Pick<Prisma.TransactionClient, "$executeRaw" | "modelRegistryEntry">;

/**
 * The product pin's registry row, read the way the vNext evaluation readback
 * reads its own (lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts,
 * left untouched as part of the evaluation record). Chat's release readiness,
 * activation and every product proposal gate on this. The caller supplies the
 * app's transaction, not model or price facts. A matching registry price does
 * not attest the provider's current published rate or permit dispatch.
 */
async function inspectPinnedModel(transaction: PriceTransaction) {
    let row: Awaited<ReturnType<PriceTransaction["modelRegistryEntry"]["findUnique"]>>;
    try {
        // Keep the price row (including an absent row) stable until the
        // caller's transaction commits. A future admission caller must lock
        // its stage before invoking this read, then lock reservation rows.
        await transaction.$executeRaw`LOCK TABLE "ModelRegistryEntry" IN SHARE MODE`;
        row = await transaction.modelRegistryEntry.findUnique({
            where: { id: PROMPT_REFINER_PRODUCT_PRICE_PIN.modelId },
        });
    } catch {
        throw new Error("prompt_refiner_product_price_read_failed");
    }
    const problems: string[] = [];
    let verifiedModel: ReturnType<typeof registryRowToModel> | undefined;
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
                estimatedPromptTokens: PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS,
            });
            const pin = PROMPT_REFINER_PRODUCT_PRICE_PIN;
            if ((row.maxOutputTokens !== null &&
                row.maxOutputTokens < PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS) ||
                price.maxOutputTokens < PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS) {
                problems.push("output_cap_below_contract");
            }
            if ((row.reservationOutputTokens !== null &&
                row.reservationOutputTokens < PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS) ||
                price.reservationOutputTokens < PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS) {
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
            if (problems.length === 0) verifiedModel = model;
        } catch {
            problems.push("model_registry_row_invalid");
        }
    }
    return { verifiedModel, problems };
}

export async function readPromptRefinerProductPrice(transaction: PriceTransaction) {
    const { problems } = await inspectPinnedModel(transaction);
    return Object.freeze({
        pricePinMatchesRegistry: problems.length === 0,
        providerPriceObserved: false as const,
        dispatchAuthorized: false as const,
        problems: Object.freeze(problems),
    });
}

/** Use the same checked row for dispatch preparation as for its price pin. */
export async function readPromptRefinerProductModel(transaction: PriceTransaction) {
    const { verifiedModel } = await inspectPinnedModel(transaction);
    if (!verifiedModel) throw new Error("prompt_refiner_product_price_drift");
    return verifiedModel;
}
