export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { z } from "zod";
import { getActiveAiModel } from "@/lib/activeAiModel";
import {
  accessibleQuickReviewers,
  buildQuickComparisonSummaryPrompt,
  COMPARISON_REVIEW_LIMITS,
  quickComparisonSummaryResultSchema,
  validateComparisonReviewInputSize,
  type QuickComparisonSummaryResult,
  type ReviewSourceResponse,
} from "@/lib/comparisonReview";
import {
  acquireChatAccess,
  assertGuestQuickSummaryDailyLimit,
  chatErrorResponse,
  ChatAccessError,
  createChatBudget,
  identifyChatCaller,
  linkChatReservationProviderRequest,
  releaseChatAccess,
  settleChatUsage,
  type ChatUsageReservation,
} from "@/lib/chatSecurity";
import { canUseModelWithPlan, getModel } from "@/lib/models";
import {
  consumePerplexityUsage,
  discardPerplexityUsage,
  perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
import {
  recordModelFailure,
  recordModelSuccess,
  recordProviderFailure,
  recordProviderSuccess,
} from "@/lib/providerMonitoring";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { ensureGuestVerified } from "@/lib/turnstile";

const QUICK_SUMMARY_MAX_OUTPUT_TOKENS = 1_200;

const jsonError = (
  error: string,
  code: string,
  status: number,
  traceId?: string
) =>
  Response.json(
    { error, code, ...(traceId ? { traceId } : {}) },
    { status, headers: { "Cache-Control": "no-store" } }
  );

const quickSummaryBudget = (
  candidate: Parameters<typeof getActiveAiModel>[0],
  inputTokens: number
) => {
  const baseBudget = createChatBudget("guest", candidate, inputTokens);
  return {
    ...baseBudget,
    maxOutputTokens: Math.min(
      baseBudget.maxOutputTokens,
      QUICK_SUMMARY_MAX_OUTPUT_TOKENS
    ),
  };
};

const requestSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(COMPARISON_REVIEW_LIMITS.maxQuestionCharacters),
    responses: z
      .array(
        z
          .object({
            messageId: z.string().min(1).max(100),
            modelId: z.string().min(1).max(120),
            content: z
              .string()
              .trim()
              .min(1)
              .max(COMPARISON_REVIEW_LIMITS.maxAnswerCharacters),
          })
          .strict()
      )
      .min(2)
      .max(COMPARISON_REVIEW_LIMITS.maxResponses),
    language: z.string().min(2).max(10).optional(),
    turnstileToken: z.string().min(1).max(2_048).optional(),
  })
  .strict();

// Guest-only counterpart to
// app/api/conversations/[conversationId]/compare-summary/route.ts. Guests
// never persist conversations/messages server-side, so the client sends
// the locally-held latest turn directly instead of this route looking one
// up by conversationId. Results are never cached/stored (no ComparisonReview
// row -- that table's userId is non-nullable) and are shown once, in that
// session only, matching the "one free taste, then log in" policy.
export async function POST(request: Request) {
  const traceId = randomUUID();
  try {
    const access = identifyChatCaller(request);
    if (access.kind !== "guest") {
      return jsonError(
        "This endpoint is for guest sessions only.",
        "GUEST_ONLY_ENDPOINT",
        400,
        traceId
      );
    }

    await consumeApiRateLimit(request, access.subjectKey, "guest-compare-summary", {
      minute: 3,
      day: 5,
    });

    const body = await readLimitedJson(request, 200 * 1024, requestSchema);

    const seenModelIds = new Set<string>();
    const responses: ReviewSourceResponse[] = [];
    for (const item of body.responses) {
      if (seenModelIds.has(item.modelId)) {
        return jsonError(
          "Each response must come from a different model.",
          "DUPLICATE_MODEL_RESPONSE",
          400,
          traceId
        );
      }
      seenModelIds.add(item.modelId);
      const model = getModel(item.modelId);
      if (!model || !canUseModelWithPlan("Guest", model)) {
        return jsonError(
          "One of the selected models isn't available to guests.",
          "MODEL_ACCESS_FORBIDDEN",
          403,
          traceId
        );
      }
      responses.push({
        messageId: item.messageId,
        modelId: model.id,
        modelName: model.name,
        provider: model.provider,
        content: item.content,
      });
    }
    validateComparisonReviewInputSize(body.question, responses);

    const turnstileGrantCookie = await ensureGuestVerified(
      request,
      body.turnstileToken,
      "guest_quick_summary"
    );

    await assertGuestQuickSummaryDailyLimit(access);

    const candidates = await accessibleQuickReviewers(access, responses);
    if (!candidates.length) {
      throw new ChatAccessError(
        503,
        "QUICK_COMPARISON_REVIEWER_UNAVAILABLE",
        "No low-cost comparison reviewer is currently configured for guests."
      );
    }

    const summaryPrompt = buildQuickComparisonSummaryPrompt({
      question: body.question,
      responses,
      language: body.language || "en",
    });
    const inputTokens = Math.ceil(
      (body.question.length + responses.reduce((sum, r) => sum + r.content.length, 0)) / 4
    );
    let lastError: unknown = new Error("No quick comparison reviewer attempted.");

    for (const candidate of candidates) {
      let leaseId: string | null = null;
      let reservation: ChatUsageReservation | null = null;
      let providerUsageTraceId: string | null = null;
      let providerUsageSnapshot: PerplexityUsageCostSnapshot | null = null;
      try {
        const budget = quickSummaryBudget(candidate, inputTokens);
        const grant = await acquireChatAccess(access, budget, {
          traceId,
          source: "comparison_review",
        });
        leaseId = grant.leaseId;
        reservation = grant.usageReservation;
        providerUsageTraceId = reservation.reservationId;
        const headers = new Headers({ "Cache-Control": "no-store" });
        if (grant.setCookie) headers.append("Set-Cookie", grant.setCookie);
        if (turnstileGrantCookie) headers.append("Set-Cookie", turnstileGrantCookie);

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
              system: summaryPrompt.system,
              prompt: summaryPrompt.prompt,
              output: Output.object({ schema: quickComparisonSummaryResultSchema }),
              temperature: 0.1,
              maxOutputTokens: budget.maxOutputTokens,
              maxRetries: 1,
              abortSignal: AbortSignal.timeout(35_000),
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
        if (!generated) throw generationError || new Error("No summary output.");
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
          console.error("Guest quick comparison provider request link failed:", {
            traceId,
            reviewerModelId: candidate.id,
            linkError,
          })
        );

        const result: QuickComparisonSummaryResult =
          quickComparisonSummaryResultSchema.parse(generated.output);

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
          console.error("Guest quick comparison settlement failed:", {
            traceId,
            reviewerModelId: candidate.id,
            settlementError,
          })
        );
        await Promise.all([
          recordProviderSuccess(candidate.provider),
          recordModelSuccess(candidate.id),
        ]);

        return Response.json(
          {
            result,
            responseMap: summaryPrompt.responseMap,
            reviewerModelId: candidate.id,
            usageCredits: budget.usageCredits,
          },
          { headers }
        );
      } catch (error) {
        lastError = error;
        if (reservation) {
          if (candidate.provider === "perplexity" && providerUsageTraceId) {
            providerUsageSnapshot = await consumePerplexityUsage(providerUsageTraceId);
          }
          await settleChatUsage(
            reservation,
            { inputTokens: 0, outputTokens: 0, outcome: "failed" },
            { providerUsageSnapshot }
          ).catch((settlementError) =>
            console.error("Guest quick comparison refund failed:", {
              traceId,
              reviewerModelId: candidate.id,
              settlementError,
            })
          );
        }
        await Promise.allSettled([
          recordProviderFailure(candidate.provider, "QUICK_COMPARISON_FAILED", {
            modelId: candidate.id,
            phase: "request",
            traceId,
            errorName: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
          }),
          recordModelFailure(candidate.id, candidate.provider, "QUICK_COMPARISON_FAILED"),
        ]);
        console.error("Guest quick comparison reviewer attempt failed:", {
          traceId,
          reviewerModelId: candidate.id,
          error,
        });
      } finally {
        if (providerUsageTraceId) {
          discardPerplexityUsage(providerUsageTraceId);
        }
        if (leaseId) await releaseChatAccess(leaseId);
      }
    }

    console.error("All guest quick comparison reviewers failed:", { traceId, lastError });
    return jsonError(
      "The quick comparison could not be completed. Reserved credits were refunded.",
      "QUICK_COMPARISON_FAILED",
      502,
      traceId
    );
  } catch (error) {
    if (error instanceof Error && error.message === "COMPARISON_REVIEW_INPUT_TOO_LARGE") {
      return jsonError(
        "The responses are too long for one quick comparison.",
        "COMPARISON_REVIEW_INPUT_TOO_LARGE",
        413,
        traceId
      );
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Guest quick comparison failed:", { traceId, error });
    return jsonError(
      "Failed to create the quick comparison.",
      "QUICK_COMPARISON_FAILED",
      500,
      traceId
    );
  }
}
