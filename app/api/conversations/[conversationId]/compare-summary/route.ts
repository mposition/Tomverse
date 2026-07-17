export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { getActiveAiModel } from "@/lib/activeAiModel";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
  buildQuickComparisonSummaryPrompt,
  createQuickComparisonSummaryHash,
  estimateComparisonReviewTokens,
  getQuickComparisonReviewerCandidates,
  QUICK_COMPARISON_PROMPT_VERSION,
  quickComparisonSummaryResultSchema,
  validateComparisonReviewInputSize,
  type QuickComparisonSummaryResult,
  type ReviewSourceResponse,
} from "@/lib/comparisonReview";
import { latestComparableConversationTurn } from "@/lib/comparisonReviewTurn";
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
import { assertModelNotAdminDisabled } from "@/lib/modelOverrides";
import type { AiModel } from "@/lib/models";
import {
  consumePerplexityUsage,
  discardPerplexityUsage,
  perplexityUsageHeaders,
} from "@/lib/perplexityUsageCapture";
import type { PerplexityUsageCostSnapshot } from "@/lib/perplexityUsageCore";
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
} from "@/lib/apiSecurity";

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

const accessibleQuickReviewers = async (
  access: ReturnType<typeof identifyChatCaller>,
  responses: ReviewSourceResponse[]
) => {
  const candidates = getQuickComparisonReviewerCandidates(
    new Set(responses.map((response) => response.provider))
  );
  const available: AiModel[] = [];
  for (const candidate of candidates) {
    try {
      assertModelAccess(access, candidate);
      const override = await assertModelNotAdminDisabled(candidate.id);
      if (override.allowed) available.push(candidate);
    } catch {
      // Try the next configured Standard reviewer.
    }
  }
  return available;
};

const responseMapForCachedSummary = (
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

const quickSummaryBudget = (candidate: AiModel, inputTokens: number) => {
  const baseBudget = createChatBudget("user", candidate, inputTokens);
  return {
    ...baseBudget,
    maxOutputTokens: Math.min(
      baseBudget.maxOutputTokens,
      QUICK_SUMMARY_MAX_OUTPUT_TOKENS
    ),
  };
};

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  const traceId = randomUUID();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401, traceId);
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "compare-summary-preview",
      { minute: 20, day: 300 }
    );

    const { conversationId } = await context.params;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true, title: true },
    });
    if (!conversation || conversation.userId !== session.user.id) {
      return jsonError("Conversation not found.", "NOT_FOUND", 404, traceId);
    }
    if (
      !hasConversationUnlockGrant(
        request,
        session.user.id,
        conversationId,
        conversation.password
      )
    ) {
      return conversationLockedResponse();
    }

    const turn = await latestComparableConversationTurn(conversationId);
    if (!turn) {
      return jsonError(
        "At least two completed model responses to the latest question are required.",
        "COMPARISON_RESPONSES_REQUIRED",
        409,
        traceId
      );
    }
    validateComparisonReviewInputSize(turn.prompt.content, turn.responses);
    const inputHash = createQuickComparisonSummaryHash({
      promptMessageId: turn.prompt.id,
      question: turn.prompt.content,
      responses: turn.responses,
    });
    const cached = await prisma.comparisonReview.findUnique({
      where: { userId_inputHash: { userId: session.user.id, inputHash } },
      select: {
        result: true,
        assistantMessageIds: true,
        isStale: true,
      },
    });
    const hasValidCache = Boolean(
      cached &&
        !cached.isStale &&
        quickComparisonSummaryResultSchema.safeParse(cached.result).success &&
        responseMapForCachedSummary(
          cached.assistantMessageIds,
          turn.responses
        )
    );
    if (hasValidCache) {
      return Response.json(
        {
          available: true,
          title: conversation.title,
          responseCount: turn.responses.length,
          estimatedCredits: 0,
          cached: true,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const billingPlan = await getUserBillingPlan(session.user.id);
    const access = identifyChatCaller(request, session.user.id, billingPlan.tier, {
      dailyMessageLimit: billingPlan.dailyMessageLimit,
      monthlyMessageLimit: billingPlan.monthlyMessageLimit,
    });
    const candidates = await accessibleQuickReviewers(access, turn.responses);
    if (!candidates.length) {
      throw new ChatAccessError(
        503,
        "QUICK_COMPARISON_REVIEWER_UNAVAILABLE",
        "No low-cost comparison reviewer is currently configured for your plan."
      );
    }
    const inputTokens = estimateComparisonReviewTokens(
      turn.prompt.content,
      turn.responses
    );
    const budget = quickSummaryBudget(candidates[0], inputTokens);
    return Response.json(
      {
        available: true,
        title: conversation.title,
        responseCount: turn.responses.length,
        estimatedCredits: budget.usageCredits,
        cached: false,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "COMPARISON_REVIEW_INPUT_TOO_LARGE"
    ) {
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
    console.error("Quick comparison preview failed:", { traceId, error });
    return jsonError(
      "Failed to prepare the quick comparison.",
      "QUICK_COMPARISON_PREVIEW_FAILED",
      500,
      traceId
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  const traceId = randomUUID();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401, traceId);
    }
    await consumeApiRateLimit(request, session.user.id, "compare-summary", {
      minute: 5,
      day: 60,
    });

    const { conversationId } = await context.params;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true, title: true },
    });
    if (!conversation || conversation.userId !== session.user.id) {
      return jsonError("Conversation not found.", "NOT_FOUND", 404, traceId);
    }
    if (
      !hasConversationUnlockGrant(
        request,
        session.user.id,
        conversationId,
        conversation.password
      )
    ) {
      return conversationLockedResponse();
    }

    const turn = await latestComparableConversationTurn(conversationId);
    if (!turn) {
      return jsonError(
        "At least two completed model responses to the latest question are required.",
        "COMPARISON_RESPONSES_REQUIRED",
        409,
        traceId
      );
    }
    validateComparisonReviewInputSize(turn.prompt.content, turn.responses);

    const inputHash = createQuickComparisonSummaryHash({
      promptMessageId: turn.prompt.id,
      question: turn.prompt.content,
      responses: turn.responses,
    });
    const cached = await prisma.comparisonReview.findUnique({
      where: {
        userId_inputHash: { userId: session.user.id, inputHash },
      },
    });
    if (cached && !cached.isStale) {
      const result = quickComparisonSummaryResultSchema.safeParse(cached.result);
      const responseMap = responseMapForCachedSummary(
        cached.assistantMessageIds,
        turn.responses
      );
      if (result.success && responseMap) {
        return Response.json(
          {
            id: cached.id,
            title: conversation.title,
            result: result.data,
            responseMap,
            reviewerModelId: cached.reviewerModelId,
            usageCredits: 0,
            originalUsageCredits: cached.usageCredits,
            cached: true,
            createdAt: cached.createdAt.toISOString(),
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
    const candidates = await accessibleQuickReviewers(access, turn.responses);
    if (!candidates.length) {
      throw new ChatAccessError(
        503,
        "QUICK_COMPARISON_REVIEWER_UNAVAILABLE",
        "No low-cost comparison reviewer is currently configured for your plan."
      );
    }

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: session.user.id },
      select: { language: true },
    });
    const summaryPrompt = buildQuickComparisonSummaryPrompt({
      question: turn.prompt.content,
      responses: turn.responses,
      language: userSettings?.language || "en",
    });
    const inputTokens = estimateComparisonReviewTokens(
      turn.prompt.content,
      turn.responses
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
          console.error("Quick comparison provider request link failed:", {
            traceId,
            reviewerModelId: candidate.id,
            linkError,
          })
        );

        const result: QuickComparisonSummaryResult =
          quickComparisonSummaryResultSchema.parse(generated.output);
        const stored = await prisma.comparisonReview.upsert({
          where: {
            userId_inputHash: { userId: session.user.id, inputHash },
          },
          create: {
            userId: session.user.id,
            conversationId,
            promptMessageId: turn.prompt.id,
            assistantMessageIds: summaryPrompt.responseMap.map(
              (response) => response.messageId
            ),
            reviewerModelId: candidate.id,
            reviewMode: "quick",
            promptVersion: QUICK_COMPARISON_PROMPT_VERSION,
            result,
            usageCredits: budget.usageCredits,
            inputHash,
          },
          update: {
            assistantMessageIds: summaryPrompt.responseMap.map(
              (response) => response.messageId
            ),
            reviewerModelId: candidate.id,
            promptVersion: QUICK_COMPARISON_PROMPT_VERSION,
            result,
            usageCredits: budget.usageCredits,
            isStale: false,
          },
        });

        const successfulReservation = reservation;
        reservation = null;
        await settleChatUsage(
          successfulReservation,
          {
            inputTokens: generated.usage.inputTokens,
            cachedInputTokens:
              generated.usage.inputTokenDetails.cacheReadTokens,
            outputTokens: generated.usage.outputTokens,
            outcome: "completed",
          },
          { providerUsageSnapshot }
        ).catch((settlementError) =>
          console.error("Quick comparison settlement failed:", {
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
            id: stored.id,
            title: conversation.title,
            result,
            responseMap: summaryPrompt.responseMap,
            reviewerModelId: candidate.id,
            usageCredits: budget.usageCredits,
            cached: false,
            createdAt: stored.createdAt.toISOString(),
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
          await settleChatUsage(
            reservation,
            { inputTokens: 0, outputTokens: 0, outcome: "failed" },
            { providerUsageSnapshot }
          ).catch((settlementError) =>
            console.error("Quick comparison refund failed:", {
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
          recordModelFailure(
            candidate.id,
            candidate.provider,
            "QUICK_COMPARISON_FAILED"
          ),
        ]);
        console.error("Quick comparison reviewer attempt failed:", {
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

    console.error("All quick comparison reviewers failed:", {
      traceId,
      lastError,
    });
    return jsonError(
      "The quick comparison could not be completed. Reserved credits were refunded.",
      "QUICK_COMPARISON_FAILED",
      502,
      traceId
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "COMPARISON_REVIEW_INPUT_TOO_LARGE"
    ) {
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
    console.error("Quick comparison failed:", { traceId, error });
    return jsonError(
      "Failed to create the quick comparison.",
      "QUICK_COMPARISON_FAILED",
      500,
      traceId
    );
  }
}
