import { z } from "zod";

import { promptRefinerResponseSchema } from "@/lib/promptRefinerSuggestion";

const uuid = z.string().uuid();
const conversationId = z.string().min(1).max(128);
const epoch = z.number().int().positive().max(2_147_483_647);
const draftRevision = z.number().int().positive().max(2_147_483_647);

export const promptRefinerProductScopeRequestSchema = z.object({
  mountId: uuid,
  conversationId,
  surface: z.enum(["chat", "workspace"]),
}).strict();

export const promptRefinerProductScopeResponseSchema = z.object({
  scopeId: uuid,
  epoch,
}).strict();

export const promptRefinerProductProposalRequestSchema = z.object({
  conversationId,
  scopeId: uuid,
  epoch,
  draftRevision,
}).strict();

export const promptRefinerProductProposalReadySchema =
  promptRefinerResponseSchema.extend({
    scopeId: uuid,
    epoch,
    clientRequestId: uuid,
  }).strict();

export const PROMPT_REFINER_PRODUCT_FALLBACK_REASONS = [
  "unavailable",
  "budget_exhausted",
  "timeout",
  "provider_error",
  "invalid_response",
  "no_change",
  "abstained",
  "stale",
  "billing_unknown",
  "audit_unavailable",
] as const;

export const promptRefinerProductFallbackReasonSchema = z.enum(
  PROMPT_REFINER_PRODUCT_FALLBACK_REASONS
);

export const promptRefinerProductProposalFallbackSchema = z.object({
  code: z.literal("PROMPT_REFINER_FALLBACK_ORIGINAL"),
  reason: promptRefinerProductFallbackReasonSchema,
}).strict();

export const promptRefinerProductChatDecisionSchema = z.object({
  suggestionId: uuid,
  scopeId: uuid,
  epoch,
  decision: z.enum(["accepted", "kept_original"]),
}).strict();

export const promptRefinerProductPrepareRequestSchema =
  promptRefinerProductProposalRequestSchema;

export const promptRefinerProductPrepareResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      outcome: z.literal("auto_held"),
      decision: promptRefinerProductChatDecisionSchema.extend({
        decision: z.literal("accepted"),
      }).strict(),
      clientRequestId: uuid,
    }).strict(),
    z.object({
      outcome: z.literal("original_fallback"),
      reason: promptRefinerProductFallbackReasonSchema,
    }).strict(),
  ]
);

export type PromptRefinerProductScopeRequest = z.infer<
  typeof promptRefinerProductScopeRequestSchema
>;
export type PromptRefinerProductScope = z.infer<
  typeof promptRefinerProductScopeResponseSchema
>;
export type PromptRefinerProductProposalRequest = z.infer<
  typeof promptRefinerProductProposalRequestSchema
>;
export type PromptRefinerProductFallbackReason = z.infer<
  typeof promptRefinerProductFallbackReasonSchema
>;
export type PromptRefinerProductChatDecision = z.infer<
  typeof promptRefinerProductChatDecisionSchema
>;
export type PromptRefinerProductPrepareResponse = z.infer<
  typeof promptRefinerProductPrepareResponseSchema
>;

