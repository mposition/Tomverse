/**
 * The model and price the Prompt Refiner product (Chat's Smart Adaptive refine
 * step) runs on, separate from the vNext evaluation pin.
 *
 * Owner decision and numeric approval, 2026-11-11: the product moves to
 * gpt-6-luna so gpt-5-6-luna can retire. Until then the product reused the
 * vNext evaluation pin, so disabling gpt-5-6-luna in Admin closed Chat for every
 * account. The evaluation pin, its numeric spec, source closure and stage
 * records stay as the historical record of what was evaluated.
 *
 * The per-request ceiling stays 29,918 micro-USD (owner decision): it was
 * derived from gpt-5.6-luna's rates and is above gpt-6-luna's worst case of
 * 14,550 (100,000 input tokens nearly all cache write, 4,096 output, each item
 * rounded up), so it remains a true upper bound, and the budget hold's database
 * constraint that fixes 29,918 needs no migration.
 *
 * Pure: no database, provider or route import.
 */
import { createHash } from "node:crypto";

import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import {
  PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

/** Rates from lib/modelPricing.ts gpt-6-luna (openai-gpt-6-luna-2026-10-12). */
export const PROMPT_REFINER_PRODUCT_PRICE_PIN = Object.freeze({
  provider: "openai",
  modelId: "gpt-6-luna",
  apiModelId: "gpt-6-luna",
  routing: "direct_provider_api",
  processingTier: "standard",
  inputUsdPerMillionTokens: 0.1,
  cachedInputPriceMultiplier: 0.1,
  cacheWriteUsdPerMillionTokens: 0.125,
  outputUsdPerMillionTokens: 0.5,
} as const);

export const PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS = PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS;
export const PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS = PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS;
export const PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD =
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD;

/** gpt-6-luna's worst case under the limits above; kept below the ceiling by test. */
export const PROMPT_REFINER_PRODUCT_WORST_CASE_MICRO_USD = 14_550 as const;

export const PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST = createHash("sha256")
  .update(canonicalBenchmarkJson({
    purpose: "prompt-refiner-product-price-pin-v1",
    pricePin: PROMPT_REFINER_PRODUCT_PRICE_PIN,
    maxInputTokens: PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS,
    maxOutputTokens: PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
    requestCeilingMicroUsd: PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD,
    numericApproval: "owner-chat-2026-11-11",
  }), "utf8")
  .digest("hex");
