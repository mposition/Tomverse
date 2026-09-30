import "server-only";

import { generateText, Output } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import {
  accessibleComparisonReviewers,
  buildComparisonReviewPrompt,
  COMPARISON_REVIEW_PROMPT_VERSION,
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
  isChatAccessError,
  linkChatReservationProviderRequest,
  releaseChatAccess,
  settleChatUsage,
  type ChatAccess,
  type ChatUsageReservation,
} from "@/lib/chatSecurity";
import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import { getModelUsageProfile, type AiModel, type ModelTier } from "@/lib/models";
import {
  consumePerplexityUsage,
  discardPerplexityUsage,
  perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";
import {
  comparisonReviewRunOutcome,
  emptyAttemptRecord,
  type ComparisonReviewAttemptRecord,
} from "@/lib/comparisonReviewRunCore";
import { ComparisonReviewRunRecorder } from "@/lib/comparisonReviewRunTelemetry";
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
  options: {
    traceId: string;
    candidates?: AiModel[];
    /**
     * What the operational record needs that the review itself does not.
     *
     * Passed by the caller rather than derived here because only the caller
     * knows whether this is a guest or an account run and which conversation
     * it belongs to -- and because the service must keep working when it is
     * absent, which is what makes a telemetry outage cost nothing but
     * telemetry.
     */
    telemetry?: {
      subjectKind: "guest" | "account";
      conversationId: string | null;
      userId: string | null;
    };
  }
): Promise<ComparisonReviewRun> => {
  const { traceId } = options;
  const candidates =
    options.candidates ??
    (await resolveComparisonReviewers(subject, input.responses));
  const recorder = options.telemetry
    ? new ComparisonReviewRunRecorder({
        traceId,
        subjectKind: options.telemetry.subjectKind,
        subjectKey: subject.access.subjectKey,
        userId: options.telemetry.userId,
        conversationId: options.telemetry.conversationId,
        reviewMode: input.reviewMode,
        language: input.language || "en",
        responseCount: input.responses.length,
        promptVersion: COMPARISON_REVIEW_PROMPT_VERSION,
      })
    : null;

  if (!candidates.length) {
    // A refusal, not a failure: nothing was sent, so nothing here is evidence
    // about a reviewer model's health, and it must not land in a
    // provider-failure rate.
    await recorder?.finish(
      "refused_before_provider",
      "COMPARISON_REVIEWER_UNAVAILABLE"
    );
    throw new ComparisonReviewerUnavailableError();
  }
  recorder?.noteDualAvailable(candidates.length > 1);

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
  ): Promise<{
    attempt: ReviewAttempt | null;
    record: ComparisonReviewAttemptRecord;
  }> => {
    const attemptStartedAt = Date.now();
    const record: ComparisonReviewAttemptRecord = {
      ...emptyAttemptRecord(),
      reviewerModelId: candidate.id,
      reviewerProvider: candidate.provider,
    };
    // Declared out here so the failure path can report them. They used to be
    // scoped to the try block, and the catch wrote `retryCount: 0` -- so an
    // attempt that retried and still failed, the case where a retry count
    // matters most, recorded no retries at all.
    let retryCount = 0;
    let reservedCredits = 0;
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
      // The same check the chat route applies, on the same shared rule: a
      // review prompt carries several complete answers, so it is exactly the
      // kind of request that outgrows a window. Run before acquireChatAccess
      // so a candidate that cannot hold this review costs no reservation and
      // no provider call -- and returns null, which moves the loop on to the
      // next reviewer instead of failing the review outright.
      const outputBudget = fitChatOutputToContextWindow({
        contextWindowTokens: candidate.contextWindowTokens,
        reservedInputTokens: budget.inputTokens,
        requestOutputCapTokens: budget.maxOutputTokens,
        providerMaxOutputTokens: budget.providerMaxOutputTokens,
      });
      if (outputBudget.kind === "exceeded") {
        // Not a failure of the model, and deliberately not recorded as one:
        // nothing was sent, so there is nothing for provider or model health
        // to learn.
        console.warn(
          JSON.stringify({
            event: "comparison_review_candidate_over_context",
            traceId,
            reviewerModelId: candidate.id,
            reservedInputTokens: budget.inputTokens,
            contextWindowTokens: outputBudget.limitTokens,
          })
        );
        return {
          attempt: null,
          record: {
            ...record,
            status: "refused",
            errorCode: "COMPARISON_REVIEW_CANDIDATE_OVER_CONTEXT",
            durationMs: Date.now() - attemptStartedAt,
          },
        };
      }
      reservedCredits = budget.usageCredits;
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
              inputTokenDetails: {
                  cacheReadTokens?: number;
                  cacheWriteTokens?: number;
                };
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
            ...getModelGenerationSettings(candidate, {
                temperature: 0.1,
                promptCachePath: "comparison_review",
            }),
            maxOutputTokens: outputBudget.outputTokens,
            // The SDK retries once, with its own backoff, before this loop
            // sees a failure. That costs the reliability scorecard something
            // and it is a deliberate trade: a request the SDK retried and won
            // returns here as a first-try success, so `retryCount` -- and
            // `retryRate` on the scorecard -- is a LOWER bound on provider
            // requests retried. Making it exact would mean maxRetries: 0 and
            // retrying here, which would also drop the backoff, and an
            // immediate re-request on a 429 is worse behaviour than an
            // unmeasured one. The metric is labelled instead.
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
          retryCount += 1;
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
      // The settlement's own status ("settled" or "refunded") is what makes
      // reservation/settlement reconciliation checkable from the operational
      // record. Nothing about the credit transaction itself changes here: the
      // call, its arguments and its lock order are exactly as they were, and
      // the result is only read.
      const settlement = await settleChatUsage(
        successfulReservation,
        {
          inputTokens: generated.usage.inputTokens,
          cachedInputTokens: generated.usage.inputTokenDetails.cacheReadTokens,
          cacheWriteInputTokens:
            generated.usage.inputTokenDetails.cacheWriteTokens,
          outputTokens: generated.usage.outputTokens,
          outcome: "completed",
        },
        { providerUsageSnapshot }
      ).catch((settlementError) => {
        console.error("Comparison review settlement failed:", {
          traceId,
          candidate: candidate.id,
          settlementError,
        });
        return null;
      });
      await Promise.all([
        recordProviderSuccess(candidate.provider),
        recordModelSuccess(candidate.id),
      ]);
      return {
        attempt: { candidate, result, usageCredits: budget.usageCredits },
        record: {
          ...record,
          status: "completed",
          durationMs: Date.now() - attemptStartedAt,
          inputTokens: generated.usage.inputTokens ?? 0,
          outputTokens: generated.usage.outputTokens ?? 0,
          reservedCredits: budget.usageCredits,
          // What settlement actually charged, not just that it ran. Without
          // the figure, a reservation of 8 that settled at 3 and one that
          // settled at 8 are the same row, and reconciliation is exactly that
          // comparison.
          settledCredits: settlement?.settledCredits ?? null,
          settlementStatus: settlement?.status ?? null,
          retryCount,
        },
      };
    } catch (error) {
      let failedSettlementStatus: string | null = null;
      let refundSettledCredits: number | null = null;
      if (reservation) {
        if (candidate.provider === "perplexity" && providerUsageTraceId) {
          providerUsageSnapshot = await consumePerplexityUsage(
            providerUsageTraceId
          );
        }
        // The refund's own outcome, recorded. A refund that failed leaves a
        // reservation holding credits nobody will release, and the only way to
        // see that in aggregate is to have written down what happened here.
        const refund = await settleChatUsage(
          reservation,
          { inputTokens: 0, outputTokens: 0, outcome: "failed" },
          { providerUsageSnapshot }
        ).catch((settlementError) => {
          console.error("Comparison review refund failed:", {
            traceId,
            candidate: candidate.id,
            settlementError,
          });
          return null;
        });
        failedSettlementStatus = refund?.status ?? null;
        refundSettledCredits = refund?.settledCredits ?? null;
      }
      // Health evidence, but only for failures that are evidence of anything.
      //
      // `acquireChatAccess` and `createChatBudget` throw ChatAccessError for
      // Tomverse's own refusals -- the user is out of credits, the review is
      // longer than their plan allows, a concurrency slot was not free. None of
      // those describes the reviewer model, and `recordModelFailure` does not
      // filter them the way `recordProviderFailure` does: it counts whatever it
      // is given, so a run of credit exhaustions was marking a perfectly
      // healthy reviewer as failing. Nothing was sent, so nothing is recorded.
      //
      // Asked of the module that owns the class, not `instanceof` here: class
      // identity belongs to the module instance, and a second evaluation of
      // chatSecurity would make a real refusal fail the check and land in the
      // health counters exactly as before.
      const isLocalRefusal = isChatAccessError(error);
      if (!isLocalRefusal) {
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
      }
      console.error("Comparison reviewer attempt failed:", {
        traceId,
        reviewerModelId: candidate.id,
        ...safeErrorMetadata(error),
      });
      const metadata = safeErrorMetadata(error);
      return {
        attempt: null,
        record: {
          ...record,
          // The same distinction the health counters just made: a local
          // refusal never reached a provider, so it is `refused` and stays out
          // of the reviewer-failure rate.
          status: isLocalRefusal ? "refused" : "failed",
          durationMs: Date.now() - attemptStartedAt,
          errorCode: metadata.code ?? "COMPARISON_REVIEW_FAILED",
          errorCategory: metadata.name ?? null,
          reservedCredits,
          // Refunded, so nothing was charged. 0 rather than null: settlement
          // ran and its answer was "none", which is a different fact from
          // "settlement did not report".
          settledCredits:
            failedSettlementStatus === null ? null : refundSettledCredits,
          settlementStatus: failedSettlementStatus,
          retryCount,
        },
      };
    } finally {
      if (providerUsageTraceId) {
        discardPerplexityUsage(providerUsageTraceId);
      }
      if (leaseId) await releaseChatAccess(leaseId);
    }
  };

  let primaryAttempt: ReviewAttempt | null = null;
  // Whether ANY attempt actually sent something. A run where every candidate
  // refused locally -- out of credits, over a limit, longer than the context
  // window -- says nothing about reviewer health and must not be counted as a
  // provider failure. `failed` and `refused_before_provider` are different
  // outcomes precisely so this case is visible as itself
  // (docs/policy/ai-review-m5-quality-contract.md §7).
  let reachedProvider = false;
  for (const candidate of candidates) {
    const outcome = await attemptReview(candidate);
    if (outcome.record.status === "completed" || outcome.record.status === "failed") {
      reachedProvider = true;
    }
    // The record is the LAST candidate tried, not the first: when a reviewer
    // is skipped and the next one succeeds, the run's story is the one that
    // ran. Each skipped candidate is still visible in its own structured log
    // line and in the provider health counters.
    recorder?.noteAttempt("primary", outcome.record);
    primaryAttempt = outcome.attempt;
    if (primaryAttempt) break;
  }
  if (!primaryAttempt) {
    await recorder?.finish(
      comparisonReviewRunOutcome({
        primaryCompleted: false,
        secondaryCompleted: false,
        reachedProvider,
      }),
      "COMPARISON_REVIEW_FAILED"
    );
    throw new ComparisonReviewFailedError();
  }

  let secondaryAttempt: ReviewAttempt | null = null;
  for (const candidate of candidates) {
    if (candidate.id === primaryAttempt.candidate.id) continue;
    const outcome = await attemptReview(candidate);
    recorder?.noteAttempt("secondary", outcome.record);
    secondaryAttempt = outcome.attempt;
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

  // Grounding is recorded from the PRIMARY reviewer's own stats, which is the
  // result the dialog opens on. It is an exact-quote match rate and nothing
  // more: it says the reviewer's quotes exist in the answers they were
  // attributed to, never that the review's conclusions are correct
  // (lib/sourceGrounding.ts).
  recorder?.noteGrounding({
    totalCitations: primaryAttempt.result.groundingStats.totalCitations,
    verifiedCitations: primaryAttempt.result.groundingStats.verifiedCitations,
    level:
      primaryAttempt.result.groundingStats.totalCitations > 0
        ? primaryAttempt.result.confidence
        : null,
  });
  await recorder?.finish(
    comparisonReviewRunOutcome({
      primaryCompleted: true,
      secondaryCompleted: Boolean(secondaryAttempt),
      reachedProvider: true,
    })
  );

  return {
    result: dualResult,
    responseMap: reviewPrompt.responseMap,
    reviewerModelId: primaryAttempt.candidate.id,
    usageCredits:
      primaryAttempt.usageCredits + (secondaryAttempt?.usageCredits || 0),
  };
};
