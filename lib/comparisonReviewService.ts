import "server-only";

import { generateText, Output } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import {
  accessibleComparisonReviewers,
  buildComparisonReviewPrompt,
  computeReviewAgreement,
  comparisonReviewResultSchema,
  estimateComparisonReviewTokens,
  verifyComparisonReviewResult,
  type ComparisonReviewMode,
  type DualComparisonReviewResult,
  type ReviewSourceResponse,
  type VerifiedComparisonReviewResult,
} from "@/lib/comparisonReview";
import {
  acquireChatAccess,
  createChatBudget,
  linkChatReservationProviderRequest,
  releaseChatAccess,
  settleChatUsage,
  type ChatAccess,
  type ChatUsageReservation,
} from "@/lib/chatSecurity";
import { getModelUsageProfile, type AiModel, type ModelTier } from "@/lib/models";
import {
  consumePerplexityUsage,
  discardPerplexityUsage,
  perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";
import {
  recordModelFailure,
  recordModelSuccess,
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/providerMonitoring";

/**
 * The AI cross-review, as one pipeline shared by every caller.
 *
 * The orchestration below -- reviewer selection, the credit reservation, the
 * generate/verify/settle cycle, the second independent reviewer and the
 * agreement comparison -- used to live inline in the signed-in conversation
 * route. Opening the same feature to guests by copying it would have produced
 * two pipelines that drift: one of them gets the next prompt-version bump, the
 * refund fix or the grounding change, and the other quietly does not.
 *
 * What genuinely differs between an account and a guest is *not* the review.
 * It is where the answers come from, which quota is spent, who owns the
 * credits and whether the result is persisted. Those stay with the callers;
 * everything below is the same code for both.
 */

/**
 * The access adapter. `access` is the real caller identity -- it decides which
 * usage buckets are charged and which per-subject limits apply, and it is never
 * synthesised (no placeholder user, no fake id).
 */
export type ComparisonReviewSubject = {
  access: ChatAccess;
  /**
   * The plan the *reviewer pool* is selected against.
   *
   * The reviewer is an internal component of the feature, not a model the
   * caller picked: nobody chooses it, it never answers the user's question and
   * it is not offered in the model picker. The plan gate exists to stop a
   * caller from running *their own* prompts on a model above their tier, so
   * applying it to the reviewer would mean a guest could pay for the feature
   * and then be told no reviewer exists -- every configured reviewer is
   * `Free`-tier.
   *
   * Guests therefore review against the same pool a Free account gets, and
   * cost is controlled where it belongs: the monthly trial quota and the guest
   * credit budget, both enforced by the caller before this service runs.
   */
  reviewerPlan: ModelTier;
};

export type ComparisonReviewInput = {
  question: string;
  responses: ReviewSourceResponse[];
  reviewMode: ComparisonReviewMode;
  includeSynthesis: boolean;
  language: string;
};

export type ComparisonReviewEstimate = {
  candidates: AiModel[];
  /** What the whole run is expected to cost, both reviewers included. */
  estimatedCredits: number;
  dualReview: boolean;
  reviewerClass: string;
};

export type ComparisonReviewRun = {
  result: DualComparisonReviewResult;
  responseMap: ReturnType<typeof buildComparisonReviewPrompt>["responseMap"];
  reviewerModelId: string;
  usageCredits: number;
};

/** No reviewer model is currently usable, so nothing was reserved or spent. */
export class ComparisonReviewerUnavailableError extends Error {
  constructor() {
    super("No comparison reviewer is currently configured.");
    this.name = "ComparisonReviewerUnavailableError";
  }
}

/** Every reviewer attempt failed. Reserved credits were already refunded. */
export class ComparisonReviewFailedError extends Error {
  constructor() {
    super("The AI comparison review could not be completed.");
    this.name = "ComparisonReviewFailedError";
  }
}

export const resolveComparisonReviewers = (
  subject: ComparisonReviewSubject,
  responses: ReviewSourceResponse[]
) =>
  accessibleComparisonReviewers(
    { kind: "user", plan: subject.reviewerPlan },
    responses
  );

/**
 * What the run is expected to cost, computed from the reviewers that would
 * actually be used and the caller's own budget rules. This is the only figure
 * a client may display; it is never read back from a request body.
 */
export const estimateComparisonReview = async (
  subject: ComparisonReviewSubject,
  input: Pick<ComparisonReviewInput, "question" | "responses">
): Promise<ComparisonReviewEstimate> => {
  const candidates = await resolveComparisonReviewers(subject, input.responses);
  if (!candidates.length) throw new ComparisonReviewerUnavailableError();

  const inputTokens = estimateComparisonReviewTokens(
    input.question,
    input.responses
  );
  const budget = createChatBudget(subject.access.kind, candidates[0], inputTokens);
  // A second independent reviewer runs whenever one is accessible, so the
  // upfront estimate reflects the real (roughly doubled) cost instead of
  // surprising the caller after the fact.
  const secondCandidate = candidates.find(
    (candidate) => candidate.id !== candidates[0].id
  );
  const secondBudget = secondCandidate
    ? createChatBudget(subject.access.kind, secondCandidate, inputTokens)
    : null;

  return {
    candidates,
    estimatedCredits: budget.usageCredits + (secondBudget?.usageCredits || 0),
    dualReview: Boolean(secondCandidate),
    reviewerClass: getModelUsageProfile(candidates[0]).category,
  };
};

type ReviewAttempt = {
  candidate: AiModel;
  result: VerifiedComparisonReviewResult;
  usageCredits: number;
};

/**
 * Runs the cross-review: primary reviewer, then a second independent one from
 * a different candidate (ideally a different provider --
 * `accessibleComparisonReviewers` already sorts for that).
 *
 * Every attempt reserves its own credits and settles them, refunding on any
 * failure, so a failed second attempt can never leave a dangling reservation.
 * If no second candidate is available or it fails, the review still completes
 * with the primary reviewer alone rather than failing outright.
 */
export const runComparisonReview = async (
  subject: ComparisonReviewSubject,
  input: ComparisonReviewInput,
  options: { traceId: string; candidates?: AiModel[] }
): Promise<ComparisonReviewRun> => {
  const { traceId } = options;
  const candidates =
    options.candidates ??
    (await resolveComparisonReviewers(subject, input.responses));
  if (!candidates.length) throw new ComparisonReviewerUnavailableError();

  const reviewPrompt = buildComparisonReviewPrompt({
    question: input.question,
    responses: input.responses,
    reviewMode: input.reviewMode,
    includeSynthesis: input.includeSynthesis,
    language: input.language || "en",
  });
  const inputTokens = estimateComparisonReviewTokens(
    input.question,
    input.responses
  );

  const attemptReview = async (
    candidate: AiModel
  ): Promise<ReviewAttempt | null> => {
    let leaseId: string | null = null;
    let reservation: ChatUsageReservation | null = null;
    let providerUsageTraceId: string | null = null;
    let providerUsageSnapshot: PerplexityUsageCostSnapshot | null = null;
    try {
      const budget = createChatBudget(
        subject.access.kind,
        candidate,
        inputTokens
      );
      const grant = await acquireChatAccess(subject.access, budget, {
        traceId,
        source: "comparison_review",
      });
      leaseId = grant.leaseId;
      reservation = grant.usageReservation;
      providerUsageTraceId = reservation.reservationId;

      let generated:
        | {
            output: unknown;
            usage: {
              inputTokens?: number;
              inputTokenDetails: { cacheReadTokens?: number };
              outputTokens?: number;
            };
            response: {
              id: string;
              headers?: Record<string, string>;
            };
          }
        | undefined;
      let generationError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          generated = await generateText({
            model: getActiveAiModel(candidate),
            system: reviewPrompt.system,
            prompt: reviewPrompt.prompt,
            output: Output.object({ schema: comparisonReviewResultSchema }),
            ...getModelGenerationSettings(candidate, { temperature: 0.1 }),
            maxOutputTokens: budget.maxOutputTokens,
            maxRetries: 1,
            abortSignal: AbortSignal.timeout(45_000),
            headers:
              candidate.provider === "perplexity"
                ? perplexityUsageHeaders(providerUsageTraceId)
                : undefined,
          });
          break;
        } catch (error) {
          generationError = error;
        }
      }
      if (!generated) throw generationError || new Error("No review output.");
      if (candidate.provider === "perplexity") {
        providerUsageSnapshot = await consumePerplexityUsage(providerUsageTraceId);
      }
      await linkChatReservationProviderRequest(reservation.reservationId, {
        providerRequestId:
          generated.response.headers?.["x-request-id"] ||
          generated.response.headers?.["request-id"] ||
          null,
        providerResponseId: generated.response.id,
      }).catch((linkError) =>
        console.error("Comparison review provider request link failed:", {
          traceId,
          candidate: candidate.id,
          linkError,
        })
      );
      const rawResult = comparisonReviewResultSchema.parse(generated.output);
      const result = verifyComparisonReviewResult(
        rawResult,
        reviewPrompt.contentByResponseId
      );

      const successfulReservation = reservation;
      reservation = null;
      await settleChatUsage(
        successfulReservation,
        {
          inputTokens: generated.usage.inputTokens,
          cachedInputTokens: generated.usage.inputTokenDetails.cacheReadTokens,
          outputTokens: generated.usage.outputTokens,
          outcome: "completed",
        },
        { providerUsageSnapshot }
      ).catch((settlementError) =>
        console.error("Comparison review settlement failed:", {
          traceId,
          candidate: candidate.id,
          settlementError,
        })
      );
      await Promise.all([
        recordProviderSuccess(candidate.provider),
        recordModelSuccess(candidate.id),
      ]);
      return { candidate, result, usageCredits: budget.usageCredits };
    } catch (error) {
      if (reservation) {
        if (candidate.provider === "perplexity" && providerUsageTraceId) {
          providerUsageSnapshot = await consumePerplexityUsage(
            providerUsageTraceId
          );
        }
        await settleChatUsage(
          reservation,
          { inputTokens: 0, outputTokens: 0, outcome: "failed" },
          { providerUsageSnapshot }
        ).catch((settlementError) =>
          console.error("Comparison review refund failed:", {
            traceId,
            candidate: candidate.id,
            settlementError,
          })
        );
      }
      await Promise.allSettled([
        recordProviderFailure(candidate.provider, "COMPARISON_REVIEW_FAILED", {
          modelId: candidate.id,
          phase: "request",
          traceId,
          errorName: safeErrorMetadata(error).name,
          errorCode: safeErrorMetadata(error).code,
          httpStatus: safeErrorMetadata(error).statusCode,
          retryable: safeErrorMetadata(error).isRetryable,
        }),
        recordModelFailure(
          candidate.id,
          candidate.provider,
          "COMPARISON_REVIEW_FAILED"
        ),
      ]);
      console.error("Comparison reviewer attempt failed:", {
        traceId,
        reviewerModelId: candidate.id,
        ...safeErrorMetadata(error),
      });
      return null;
    } finally {
      if (providerUsageTraceId) {
        discardPerplexityUsage(providerUsageTraceId);
      }
      if (leaseId) await releaseChatAccess(leaseId);
    }
  };

  let primaryAttempt: ReviewAttempt | null = null;
  for (const candidate of candidates) {
    primaryAttempt = await attemptReview(candidate);
    if (primaryAttempt) break;
  }
  if (!primaryAttempt) throw new ComparisonReviewFailedError();

  let secondaryAttempt: ReviewAttempt | null = null;
  for (const candidate of candidates) {
    if (candidate.id === primaryAttempt.candidate.id) continue;
    secondaryAttempt = await attemptReview(candidate);
    if (secondaryAttempt) break;
  }

  const dualResult: DualComparisonReviewResult = {
    primary: {
      reviewerModelId: primaryAttempt.candidate.id,
      result: primaryAttempt.result,
    },
    secondary: secondaryAttempt
      ? {
          reviewerModelId: secondaryAttempt.candidate.id,
          result: secondaryAttempt.result,
        }
      : null,
    agreement: secondaryAttempt
      ? computeReviewAgreement(primaryAttempt.result, secondaryAttempt.result)
      : null,
  };

  return {
    result: dualResult,
    responseMap: reviewPrompt.responseMap,
    reviewerModelId: primaryAttempt.candidate.id,
    usageCredits:
      primaryAttempt.usageCredits + (secondaryAttempt?.usageCredits || 0),
  };
};
