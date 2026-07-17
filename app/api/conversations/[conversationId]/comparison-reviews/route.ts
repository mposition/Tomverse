export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import {
  consumePerplexityUsage,
  discardPerplexityUsage,
  perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
  buildComparisonReviewPrompt,
  COMPARISON_REVIEW_PROMPT_VERSION,
  comparisonReviewModeSchema,
  comparisonReviewResultSchema,
  createComparisonReviewHash,
  estimateComparisonReviewTokens,
  getComparisonReviewerCandidates,
  validateComparisonReviewInputSize,
  type ComparisonReviewResult,
  type ReviewSourceResponse,
} from "@/lib/comparisonReview";
import {
  latestComparableConversationTurn,
  requestedComparableConversationTurn,
} from "@/lib/comparisonReviewTurn";
import {
  releaseFreeComparisonReview,
  reserveFreeComparisonReview,
  getFreeComparisonReviewLimit,
  type ComparisonReviewQuotaReservation,
} from "@/lib/comparisonReviewQuota";
import {
  acquireChatAccess,
  assertModelAccess,
  chatErrorResponse,
  ChatAccessError,
  createChatBudget,
  identifyChatCaller,
  linkChatReservationProviderRequest,
  releaseChatAccess,
  settleChatUsage,
  type ChatUsageReservation,
} from "@/lib/chatSecurity";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { assertModelRuntimeAvailable } from "@/lib/modelAvailability";
import { getModelUsageProfile, type AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
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

const reviewRequestSchema = z
  .object({
    promptMessageId: z.string().uuid(),
    assistantMessageIds: z.array(z.string().uuid()).min(2).max(3),
    reviewMode: comparisonReviewModeSchema,
    includeSynthesis: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.assistantMessageIds).size !== value.assistantMessageIds.length) {
      context.addIssue({
        code: "custom",
        path: ["assistantMessageIds"],
        message: "Response IDs must be unique.",
      });
    }
  });

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

const authorizeConversation = async (
  request: Request,
  userId: string,
  conversationId: string
) => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, password: true, title: true },
  });
  if (!conversation || conversation.userId !== userId) {
    return { response: jsonError("Conversation not found.", "NOT_FOUND", 404) };
  }
  if (
    !hasConversationUnlockGrant(
      request,
      userId,
      conversationId,
      conversation.password
    )
  ) {
    return { response: conversationLockedResponse() };
  }
  return { conversation };
};

const accessibleCandidates = async (
  access: ReturnType<typeof identifyChatCaller>,
  responses: ReviewSourceResponse[]
) => {
  const candidates = getComparisonReviewerCandidates(
    new Set(responses.map((response) => response.provider))
  );
  const available: AiModel[] = [];
  for (const candidate of candidates) {
    try {
      assertModelAccess(access, candidate);
      const override = await assertModelRuntimeAvailable(candidate.id);
      if (override.allowed) available.push(candidate);
    } catch {
      // A configured fallback can be outside this plan's model tier.
    }
  }
  return available;
};

const responseMapForStoredReview = (
  storedIds: unknown,
  responses: ReviewSourceResponse[]
) => {
  const parsedIds = z.array(z.string()).min(2).max(3).safeParse(storedIds);
  if (!parsedIds.success) return null;
  const byId = new Map(responses.map((response) => [response.messageId, response]));
  const labels = ["A", "B", "C"] as const;
  const mapped = parsedIds.data.map((messageId, index) => {
    const response = byId.get(messageId);
    return response
      ? {
          responseId: labels[index],
          messageId,
          modelId: response.modelId,
          modelName: response.modelName,
        }
      : null;
  });
  return mapped.every(Boolean) ? mapped : null;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401);
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "comparison-review-preview",
      { minute: 20, day: 300 }
    );
    const { conversationId } = await context.params;
    const authorization = await authorizeConversation(
      request,
      session.user.id,
      conversationId
    );
    if ("response" in authorization) return authorization.response;

    const turn = await latestComparableConversationTurn(conversationId);
    if (!turn) {
      return Response.json(
        {
          available: false,
          reason: "At least two completed model responses from the same question are required.",
          code: "COMPARISON_RESPONSES_REQUIRED",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    validateComparisonReviewInputSize(turn.prompt.content, turn.responses);
    const billingPlan = await getUserBillingPlan(session.user.id);
    const access = identifyChatCaller(request, session.user.id, billingPlan.tier, {
      dailyMessageLimit: billingPlan.dailyMessageLimit,
      monthlyMessageLimit: billingPlan.monthlyMessageLimit,
    });
    const candidates = await accessibleCandidates(access, turn.responses);
    if (!candidates.length) {
      return jsonError(
        "No comparison reviewer is currently configured for your plan.",
        "COMPARISON_REVIEWER_UNAVAILABLE",
        503
      );
    }
    const inputTokens = estimateComparisonReviewTokens(
      turn.prompt.content,
      turn.responses
    );
    const budget = createChatBudget("user", candidates[0], inputTokens);

    return Response.json(
      {
        available: true,
        title: authorization.conversation.title,
        promptMessageId: turn.prompt.id,
        assistantMessageIds: turn.responses.map((response) => response.messageId),
        responses: turn.responses.map((response) => ({
          messageId: response.messageId,
          modelId: response.modelId,
          modelName: response.modelName,
        })),
        estimatedCredits: budget.usageCredits,
        reviewerClass: getModelUsageProfile(candidates[0]).category,
        reviewModes: ["balanced", "evidence", "action"],
        freeMonthlyReviews:
          billingPlan.tier === "Free"
            ? getFreeComparisonReviewLimit()
            : null,
        disclaimer:
          "AI cross-review compares the supplied answers. It does not externally verify facts or search the web.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "COMPARISON_REVIEW_INPUT_TOO_LARGE"
    ) {
      return jsonError(
        "The responses are too long for one comparison review.",
        "COMPARISON_REVIEW_INPUT_TOO_LARGE",
        413
      );
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Comparison review preview failed:", error);
    return jsonError(
      "Failed to prepare the comparison review.",
      "COMPARISON_REVIEW_PREVIEW_FAILED",
      500
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  const traceId = randomUUID();
  let freeQuota: ComparisonReviewQuotaReservation | null = null;
  let completed = false;
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401, traceId);
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "comparison-review-create",
      { minute: 5, day: 30 }
    );
    const { conversationId } = await context.params;
    const authorization = await authorizeConversation(
      request,
      session.user.id,
      conversationId
    );
    if ("response" in authorization) return authorization.response;
    const payload = await readLimitedJson(
      request,
      16 * 1024,
      reviewRequestSchema
    );
    const turn = await requestedComparableConversationTurn(
      conversationId,
      payload.promptMessageId,
      payload.assistantMessageIds
    );
    if (!turn) {
      return jsonError(
        "The selected responses must be completed answers to the same question.",
        "INVALID_COMPARISON_TURN",
        400,
        traceId
      );
    }
    validateComparisonReviewInputSize(turn.prompt.content, turn.responses);
    const inputHash = createComparisonReviewHash({
      promptMessageId: turn.prompt.id,
      question: turn.prompt.content,
      responses: turn.responses,
      reviewMode: payload.reviewMode,
      includeSynthesis: payload.includeSynthesis,
    });
    const cached = await prisma.comparisonReview.findUnique({
      where: {
        userId_inputHash: { userId: session.user.id, inputHash },
      },
    });
    if (cached && !cached.isStale) {
      const result = comparisonReviewResultSchema.safeParse(cached.result);
      const responseMap = responseMapForStoredReview(
        cached.assistantMessageIds,
        turn.responses
      );
      if (result.success && responseMap) {
        return Response.json(
          {
            id: cached.id,
            result: result.data,
            responseMap,
            reviewerModelId: cached.reviewerModelId,
            usageCredits: 0,
            originalUsageCredits: cached.usageCredits,
            cached: true,
            createdAt: cached.createdAt.toISOString(),
            disclaimer:
              "This AI review compares supplied answers and is not external fact verification.",
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
    }

    const billingPlan = await getUserBillingPlan(session.user.id);
    const access = identifyChatCaller(request, session.user.id, billingPlan.tier, {
      dailyMessageLimit: billingPlan.dailyMessageLimit,
      monthlyMessageLimit: billingPlan.monthlyMessageLimit,
    });
    if (billingPlan.tier === "Free") {
      freeQuota = await reserveFreeComparisonReview(access.subjectKey);
    }
    const candidates = await accessibleCandidates(access, turn.responses);
    if (!candidates.length) {
      throw new ChatAccessError(
        503,
        "COMPARISON_REVIEWER_UNAVAILABLE",
        "No comparison reviewer is currently configured for your plan."
      );
    }

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: session.user.id },
      select: { language: true },
    });
    const reviewPrompt = buildComparisonReviewPrompt({
      question: turn.prompt.content,
      responses: turn.responses,
      reviewMode: payload.reviewMode,
      includeSynthesis: payload.includeSynthesis,
      language: userSettings?.language || "en",
    });
    const inputTokens = estimateComparisonReviewTokens(
      turn.prompt.content,
      turn.responses
    );
    let lastError: unknown = new Error("No reviewer attempted.");

    for (const candidate of candidates) {
      let leaseId: string | null = null;
      let reservation: ChatUsageReservation | null = null;
      let providerUsageTraceId: string | null = null;
      let providerUsageSnapshot: PerplexityUsageCostSnapshot | null = null;
      try {
        const budget = createChatBudget("user", candidate, inputTokens);
        const grant = await acquireChatAccess(access, budget, {
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
              temperature: 0.1,
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
          providerUsageSnapshot = await consumePerplexityUsage(
            providerUsageTraceId
          );
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
        const result: ComparisonReviewResult = comparisonReviewResultSchema.parse(
          generated.output
        );
        const stored = await prisma.comparisonReview.upsert({
          where: {
            userId_inputHash: { userId: session.user.id, inputHash },
          },
          create: {
            userId: session.user.id,
            conversationId,
            promptMessageId: turn.prompt.id,
            assistantMessageIds: reviewPrompt.responseMap.map(
              (response) => response.messageId
            ),
            reviewerModelId: candidate.id,
            reviewMode: payload.reviewMode,
            promptVersion: COMPARISON_REVIEW_PROMPT_VERSION,
            result,
            usageCredits: budget.usageCredits,
            inputHash,
          },
          update: {
            assistantMessageIds: reviewPrompt.responseMap.map(
              (response) => response.messageId
            ),
            reviewerModelId: candidate.id,
            result,
            usageCredits: budget.usageCredits,
            isStale: false,
          },
        });
        const successfulReservation = reservation;
        reservation = null;
        await settleChatUsage(successfulReservation, {
          inputTokens: generated.usage.inputTokens,
          cachedInputTokens: generated.usage.inputTokenDetails.cacheReadTokens,
          outputTokens: generated.usage.outputTokens,
          outcome: "completed",
        }, {
          providerUsageSnapshot,
        }).catch((settlementError) =>
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
        completed = true;
        return Response.json(
          {
            id: stored.id,
            result,
            responseMap: reviewPrompt.responseMap,
            reviewerModelId: candidate.id,
            usageCredits: budget.usageCredits,
            cached: false,
            createdAt: stored.createdAt.toISOString(),
            disclaimer:
              "This AI review compares supplied answers and is not external fact verification.",
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch (error) {
        lastError = error;
        if (reservation) {
          if (candidate.provider === "perplexity" && providerUsageTraceId) {
            providerUsageSnapshot = await consumePerplexityUsage(
              providerUsageTraceId
            );
          }
          await settleChatUsage(reservation, {
            inputTokens: 0,
            outputTokens: 0,
            outcome: "failed",
          }, {
            providerUsageSnapshot,
          }).catch((settlementError) =>
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
            errorName: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
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
          error,
        });
      } finally {
        if (providerUsageTraceId) {
          discardPerplexityUsage(providerUsageTraceId);
        }
        if (leaseId) await releaseChatAccess(leaseId);
      }
    }

    console.error("All comparison reviewers failed:", { traceId, lastError });
    return jsonError(
      "The AI comparison review could not be completed. Reserved credits were refunded.",
      "COMPARISON_REVIEW_FAILED",
      502,
      traceId
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "COMPARISON_REVIEW_INPUT_TOO_LARGE"
    ) {
      return jsonError(
        "The responses are too long for one comparison review.",
        "COMPARISON_REVIEW_INPUT_TOO_LARGE",
        413,
        traceId
      );
    }
    if (error instanceof z.ZodError) {
      return jsonError(
        "Invalid comparison review request.",
        "INVALID_COMPARISON_REVIEW_REQUEST",
        400,
        traceId
      );
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Comparison review failed:", { traceId, error });
    return jsonError(
      "Failed to create the comparison review.",
      "COMPARISON_REVIEW_FAILED",
      500,
      traceId
    );
  } finally {
    if (freeQuota && !completed) {
      await releaseFreeComparisonReview(freeQuota).catch((error) =>
        console.error("Comparison review quota refund failed:", {
          traceId,
          error,
        })
      );
    }
  }
}
