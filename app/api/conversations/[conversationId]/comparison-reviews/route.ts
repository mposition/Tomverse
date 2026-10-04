export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
  COMPARISON_REVIEW_PROMPT_VERSION,
  comparisonReviewModeSchema,
  createComparisonReviewHash,
  dualComparisonReviewResultSchema,
  validateComparisonReviewInputSize,
  type ReviewSourceResponse,
} from "@/lib/comparisonReview";
import {
  estimateComparisonReview,
  runComparisonReview,
  ComparisonReviewerUnavailableError,
  ComparisonReviewFailedError,
  type ComparisonReviewSubject,
} from "@/lib/comparisonReviewService";
import {
  latestComparableConversationTurn,
  requestedComparableConversationTurn,
} from "@/lib/comparisonReviewTurn";
import { emptyAttemptRecord } from "@/lib/comparisonReviewRunCore";
import {
  comparisonReviewItems,
  type ComparisonReviewItemSource,
} from "@/lib/comparisonReviewItemFeedback";
import { recordComparisonReviewRun } from "@/lib/comparisonReviewRunTelemetry";
import {
  releaseComparisonReviewQuota,
  reserveFreeComparisonReview,
  getFreeComparisonReviewLimit,
  type ComparisonReviewQuotaReservation,
} from "@/lib/comparisonReviewQuota";
import {
  chatErrorResponse,
  ChatAccessError,
  identifyChatCaller,
} from "@/lib/chatSecurity";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
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
    select: { id: true, userId: true, password: true, title: true, kind: true },
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
  // Comparison reviews are a chat-conversation feature; image conversations
  // have no model answers to compare (docs/policy/image-generation.md §1).
  if (!isChatConversationKind(conversation.kind)) {
    return { response: conversationKindNotSupportedResponse() };
  }
  return { conversation };
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

/**
 * The per-claim identifiers the feedback control needs.
 *
 * Derived here rather than stored (lib/comparisonReviewItemFeedback.ts) and
 * sent with the review rather than recomputed in the browser: the derivation
 * hashes with node:crypto, and a second implementation in the client would be
 * a second place for the two to stop agreeing.
 */
const reviewItemIds = (result: {
  primary: { result: ComparisonReviewItemSource };
  secondary: { result: ComparisonReviewItemSource } | null;
}) =>
  [
    ...comparisonReviewItems(result.primary.result, "primary"),
    ...(result.secondary
      ? comparisonReviewItems(result.secondary.result, "secondary")
      : []),
  ].map((item) => ({
    id: item.id,
    reviewer: item.reviewer,
    section: item.section,
    ordinal: item.ordinal,
  }));

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
    // The same estimate the guest preview uses, from the same service: two
    // callers, one definition of what a cross-review costs.
    let estimate;
    try {
      estimate = await estimateComparisonReview(
        { access, reviewerPlan: billingPlan.tier },
        { question: turn.prompt.content, responses: turn.responses }
      );
    } catch (error) {
      if (error instanceof ComparisonReviewerUnavailableError) {
        return jsonError(
          "No comparison reviewer is currently configured for your plan.",
          "COMPARISON_REVIEWER_UNAVAILABLE",
          503
        );
      }
      throw error;
    }

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
        estimatedCredits: estimate.estimatedCredits,
        dualReview: estimate.dualReview,
        reviewerClass: estimate.reviewerClass,
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
      const result = dualComparisonReviewResultSchema.safeParse(cached.result);
      const responseMap = responseMapForStoredReview(
        cached.assistantMessageIds,
        turn.responses
      );
      if (result.success && responseMap) {
        // A cache hit is a distinct outcome, not an absence of one. Left
        // unrecorded it would deflate the completion rate (a user got their
        // review) and inflate the provider-failure rate's denominator with
        // runs that never called anybody.
        const now = new Date();
        await recordComparisonReviewRun({
          traceId,
          subjectKind: "account",
          subjectKey: `user:${session.user.id}`,
          userId: session.user.id,
          conversationId,
          reviewMode: payload.reviewMode,
          language: "",
          responseCount: turn.responses.length,
          promptVersion: cached.promptVersion,
          outcome: "cached",
          errorCode: null,
          startedAt: now,
          completedAt: now,
          dualReviewRequested: true,
          dualReviewAvailable: Boolean(result.data.secondary),
          primary: {
            ...emptyAttemptRecord(),
            reviewerModelId: cached.reviewerModelId,
            status: "not_attempted",
          },
          secondary: emptyAttemptRecord(),
          // A cache hit dispatched nothing, so it has no attempts. An empty
          // list is the honest record; a synthesised one would put a
          // reviewer into failure-rate denominators that never ran.
          attempts: [],
          groundingTotalQuotes:
            result.data.primary.result.groundingStats.totalCitations,
          groundingMatchedQuotes:
            result.data.primary.result.groundingStats.verifiedCitations,
          sourceGroundingLevel:
            result.data.primary.result.groundingStats.totalCitations > 0
              ? result.data.primary.result.confidence
              : null,
        }).catch((error) =>
          console.error("Cached comparison review telemetry failed:", {
            traceId,
            error,
          })
        );
        return Response.json(
          {
            id: cached.id,
            result: result.data,
            reviewItems: reviewItemIds(result.data),
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

    const userSettings = await prisma.userSettings.findUnique({
      where: { userId: session.user.id },
      select: { language: true },
    });
    const subject: ComparisonReviewSubject = {
      access,
      reviewerPlan: billingPlan.tier,
    };

    // The pipeline itself -- reviewer selection, credit reservation, the two
    // independent reviews, grounding verification and settlement -- is shared
    // with the guest route. What stays here is what is genuinely this route's:
    // the conversation the answers came from, the Free-plan quota, the cache
    // and the persisted ComparisonReview row.
    let run;
    try {
      run = await runComparisonReview(
        subject,
        {
          question: turn.prompt.content,
          responses: turn.responses,
          reviewMode: payload.reviewMode,
          includeSynthesis: payload.includeSynthesis,
          language: userSettings?.language || "en",
        },
        {
          traceId,
          telemetry: {
            subjectKind: "account",
            conversationId,
            userId: session.user.id,
          },
        }
      );
    } catch (error) {
      if (error instanceof ComparisonReviewerUnavailableError) {
        throw new ChatAccessError(
          503,
          "COMPARISON_REVIEWER_UNAVAILABLE",
          "No comparison reviewer is currently configured for your plan."
        );
      }
      if (error instanceof ComparisonReviewFailedError) {
        console.error("All comparison reviewers failed:", { traceId });
        return jsonError(
          "The AI comparison review could not be completed. Reserved credits were refunded.",
          "COMPARISON_REVIEW_FAILED",
          502,
          traceId
        );
      }
      throw error;
    }

    const stored = await prisma.comparisonReview.upsert({
      where: {
        userId_inputHash: { userId: session.user.id, inputHash },
      },
      create: {
        userId: session.user.id,
        conversationId,
        promptMessageId: turn.prompt.id,
        assistantMessageIds: run.responseMap.map(
          (response) => response.messageId
        ),
        reviewerModelId: run.reviewerModelId,
        reviewMode: payload.reviewMode,
        promptVersion: COMPARISON_REVIEW_PROMPT_VERSION,
        result: run.result,
        usageCredits: run.usageCredits,
        inputHash,
      },
      update: {
        assistantMessageIds: run.responseMap.map(
          (response) => response.messageId
        ),
        reviewerModelId: run.reviewerModelId,
        result: run.result,
        usageCredits: run.usageCredits,
        isStale: false,
      },
    });
    completed = true;
    return Response.json(
      {
        id: stored.id,
        result: run.result,
        reviewItems: reviewItemIds(run.result),
        responseMap: run.responseMap,
        reviewerModelId: run.reviewerModelId,
        usageCredits: run.usageCredits,
        cached: false,
        createdAt: stored.createdAt.toISOString(),
        disclaimer:
          "This AI review compares supplied answers and is not external fact verification.",
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
      await releaseComparisonReviewQuota(freeQuota).catch((error) =>
        console.error("Comparison review quota refund failed:", {
          traceId,
          error,
        })
      );
    }
  }
}
