import "server-only";

import { z } from "zod";
import {
  comparisonReviewModeSchema,
  GUEST_COMPARISON_REVIEW_LIMITS,
  validateComparisonReviewInputSize,
  type ReviewSourceResponse,
} from "@/lib/comparisonReview";
import { canUseModelWithPlan, getModel } from "@/lib/models";
import { ChatAccessError } from "@/lib/chatSecurity";

/**
 * The guest AI Review request contract, shared by the preview and the run so
 * the two can never disagree about what a valid payload is.
 *
 * Guests have no server-side conversation to name answers by id, so -- exactly
 * as the guest quick summary already does -- the answers travel in the request
 * body. That makes this endpoint the one place where a caller supplies the
 * text a paid reviewer will read, so the schema is the security boundary:
 * bounded question, bounded answers, bounded count, a bounded whole, and every
 * model id resolved against the catalogue rather than trusted.
 */

const RESPONSE_SCHEMA = z
  .object({
    messageId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(120),
    content: z
      .string()
      .trim()
      .min(1)
      .max(GUEST_COMPARISON_REVIEW_LIMITS.maxAnswerCharacters),
  })
  .strict();

const BASE_FIELDS = {
  question: z
    .string()
    .trim()
    .min(1)
    .max(GUEST_COMPARISON_REVIEW_LIMITS.maxQuestionCharacters),
  responses: z
    .array(RESPONSE_SCHEMA)
    .min(2)
    .max(GUEST_COMPARISON_REVIEW_LIMITS.maxResponses),
  language: z.string().min(2).max(10).optional(),
  turnstileToken: z.string().min(1).max(2_048).optional(),
};

export const guestComparisonReviewPreviewSchema = z
  .object(BASE_FIELDS)
  .strict();

export const guestComparisonReviewRunSchema = z
  .object({
    ...BASE_FIELDS,
    reviewMode: comparisonReviewModeSchema,
    includeSynthesis: z.boolean().optional().default(false),
    // Client-generated per user-initiated run. Never a cost, a quota state or
    // a reviewer choice -- the only thing a client is trusted to name here is
    // "this is the same click as before".
    idempotencyKey: z.string().min(8).max(100),
  })
  .strict();

/** The request body cap. Sized just above the character limits above. */
export const GUEST_COMPARISON_REVIEW_MAX_BODY_BYTES = 160 * 1024;

/**
 * Resolves the submitted answers into review sources.
 *
 * Every model id must be a real, guest-accessible catalogue model that could
 * genuinely have produced the answer in this session -- so the endpoint cannot
 * be used as a general-purpose "review this text I pasted" service against a
 * model tier the caller has no access to.
 */
export const resolveGuestReviewResponses = (
  responses: Array<z.infer<typeof RESPONSE_SCHEMA>>
): ReviewSourceResponse[] => {
  const seenModelIds = new Set<string>();
  const resolved: ReviewSourceResponse[] = [];
  for (const item of responses) {
    if (seenModelIds.has(item.modelId)) {
      throw new ChatAccessError(
        400,
        "DUPLICATE_MODEL_RESPONSE",
        "Each response must come from a different model."
      );
    }
    seenModelIds.add(item.modelId);
    const model = getModel(item.modelId);
    if (!model || !canUseModelWithPlan("Guest", model)) {
      throw new ChatAccessError(
        403,
        "MODEL_ACCESS_FORBIDDEN",
        "One of the selected models isn't available to guests."
      );
    }
    resolved.push({
      messageId: item.messageId,
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      content: item.content,
    });
  }
  return resolved;
};

export const assertGuestReviewInputSize = (
  question: string,
  responses: ReviewSourceResponse[]
) =>
  validateComparisonReviewInputSize(
    question,
    responses,
    GUEST_COMPARISON_REVIEW_LIMITS
  );
