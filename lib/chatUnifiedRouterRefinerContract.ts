import "server-only";

import { createHash } from "node:crypto";
import { canonicalBenchmarkJson } from "./routerDevelopmentBenchmark";
import {
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_PRODUCT_RETRY_COUNT,
  PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
} from "./promptRefinerProductContract";
import {
  PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
} from "./promptRefinerQualityEvaluationVnextExecutionContract";
import { CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION } from "./chatUnifiedRouterRefinerCore";
import {
  CHAT_UNIFIED_ROUTER_REFINER_PROMPT_VERSION,
  CHAT_UNIFIED_ROUTER_REFINER_SYSTEM_INSTRUCTION,
} from "./chatUnifiedRouterRefinerPrompt";

export const CHAT_UNIFIED_ROUTER_REFINER_ADAPTER_VERSION = "chat-unified-product-adapter-v1" as const;
const digest = (value: unknown) => createHash("sha256")
  .update(canonicalBenchmarkJson(value), "utf8").digest("hex");

/** A distinct stage identity; none of these digests contains a user's text. */
export const CHAT_UNIFIED_ROUTER_REFINER_CANDIDATE_IDENTITY = Object.freeze({
  contractVersion: "chat-unified-product-v1",
  schemaVersion: CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION,
  promptVersion: CHAT_UNIFIED_ROUTER_REFINER_PROMPT_VERSION,
  systemPrompt: CHAT_UNIFIED_ROUTER_REFINER_SYSTEM_INSTRUCTION,
  parser: "parseChatUnifiedRouterRefinerOutput",
  inputScope: "current_user_turn_text_only",
  model: PROMPT_REFINER_VNEXT_PRICE_PIN,
  maxInputTokens: PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
  maxOutputTokens: PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
  timeoutMs: PROMPT_REFINER_PRODUCT_TIMEOUT_MS,
  retryCount: PROMPT_REFINER_PRODUCT_RETRY_COUNT,
  requestCeilingMicroUsd: PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
});
export const CHAT_UNIFIED_ROUTER_REFINER_CANDIDATE_DIGEST =
  digest(CHAT_UNIFIED_ROUTER_REFINER_CANDIDATE_IDENTITY);
export const CHAT_UNIFIED_ROUTER_REFINER_ADAPTER_CONFIG_DIGEST = digest({
  adapterVersion: CHAT_UNIFIED_ROUTER_REFINER_ADAPTER_VERSION,
  candidateDigest: CHAT_UNIFIED_ROUTER_REFINER_CANDIDATE_DIGEST,
  transport: "openai.responses",
  reasoningEffort: "medium",
  toolChoice: "none",
  cacheWriteTokensRequired: 0,
});
