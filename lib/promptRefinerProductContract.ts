import { createHash } from "node:crypto";

import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import {
  PROMPT_REFINER_VNEXT_CANDIDATE_SYSTEM_PROMPT,
  PROMPT_REFINER_VNEXT_CANDIDATE_VERSION,
} from "@/lib/promptRefinerQualityEvaluationVnextCandidate";
import {
  PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
export {
  PROMPT_REFINER_PRODUCT_FALLBACK_REASONS,
  promptRefinerProductProposalRequestSchema,
  promptRefinerProductScopeRequestSchema,
} from "@/lib/promptRefinerProductApiContract";
export type { PromptRefinerProductFallbackReason } from
  "@/lib/promptRefinerProductApiContract";

export const PROMPT_REFINER_PRODUCT_CONTRACT_VERSION =
  "prompt-refiner-product-v1" as const;
export const PROMPT_REFINER_PRODUCT_ADAPTER_VERSION =
  "prompt-refiner-product-adapter-v1" as const;
export const PROMPT_REFINER_PRODUCT_TIMEOUT_MS = 13_000 as const;
export const PROMPT_REFINER_PRODUCT_RETRY_COUNT = 0 as const;
export const PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD =
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD;

const sha256 = (value: unknown) => createHash("sha256")
  .update(canonicalBenchmarkJson(value), "utf8")
  .digest("hex");

/**
 * Product identity reuses the evaluated prompt/parser/model/price pins but has
 * its own 13 second deadline. It does not edit the frozen 15 second one-shot
 * evaluation contract or borrow that run's slot/cost authority.
 */
export const PROMPT_REFINER_PRODUCT_CANDIDATE_IDENTITY = Object.freeze({
  contractVersion: PROMPT_REFINER_PRODUCT_CONTRACT_VERSION,
  candidateVersion: PROMPT_REFINER_VNEXT_CANDIDATE_VERSION,
  systemPrompt: PROMPT_REFINER_VNEXT_CANDIDATE_SYSTEM_PROMPT,
  parser: "parsePromptRefinerVnextModelOutput",
  inputScope: "current_user_turn_text_only",
  model: PROMPT_REFINER_VNEXT_PRICE_PIN,
  maxInputTokens: PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  maxOutputTokens: PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  timeoutMs: PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
  retryCount: PROMPT_REFINER_PRODUCT_RETRY_COUNT,
  requestCeilingMicroUsd: PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD,
  pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
});

export const PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST =
  sha256(PROMPT_REFINER_PRODUCT_CANDIDATE_IDENTITY);

/** Content-free adapter/config identity. It never hashes a user's prompt. */
export const PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST = sha256({
  adapterVersion: PROMPT_REFINER_PRODUCT_ADAPTER_VERSION,
  candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  transport: "openai.responses",
  reasoningEffort: "medium",
  toolChoice: "none",
  cacheWriteTokensRequired: 0,
});

export const PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST =
  PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST;

