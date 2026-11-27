export const dynamic = "force-dynamic";
import { withReviewProgress, type PublishReviewProgress } from "@/lib/comparisonReviewProgress";

import { randomUUID } from "node:crypto";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { z } from "zod";
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
  getUserChatUsageKey,
  identifyChatCaller,
} from "@/lib/chatSecurity";
import {
  claimInFlightRun,
  isInFlightRunLive,
  releaseInFlightRun,
  type InFlightRunClaim,
} from "@/lib/guestIdempotency";
import {
  COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT,
  COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE,
  COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS,
  COMPARISON_REVIEW_SAVED_BEFORE_NONE,
  COMPARISON_REVIEW_TURN_NOT_FOUND,
} from "@/lib/comparisonReviewInFlight";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { prisma } from "@/lib/prisma";
import { DESKTOP_APP_ORIGIN, desktopConversationWriteProduct, desktopReviewAnalysisEnabled } from "@/lib/desktopReadApiContract";
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

/** The exact turn a saved-result lookup may name (see GET). */
const storedTurnLookupSchema = z.object({
  reviewMode: comparisonReviewModeSchema,
  includeSynthesis: z.boolean(),
  promptMessageId: z.string().uuid(),
  assistantMessageIds: z.array(z.string().uuid()).min(2).max(3),
  savedBefore: z.union([
    z.literal(COMPARISON_REVIEW_SAVED_BEFORE_NONE),
    z.string().datetime(),
  ]),
});
type StoredTurnLookup = z.infer<typeof storedTurnLookupSchema>;

const parseStoredTurnLookup = (query: URLSearchParams): StoredTurnLookup | null => {
  const parsed = storedTurnLookupSchema.safeParse({
    reviewMode: query.get("reviewMode"),
    includeSynthesis: query.get("includeSynthesis") === "true",
    promptMessageId: query.get("promptMessageId"),
    assistantMessageIds: query.get("assistantMessageIds")?.split(","),
    savedBefore: query.get("savedBefore"),
  });
  return parsed.success ? parsed.data : null;
};

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
    select: { id: true, userId: true, password: true, passwordVersion: true, title: true, kind: true, productKey: true },
  });
  if (!conversation || conversation.userId !== userId) {
    return { response: jsonError("Conversation not found.", "NOT_FOUND", 404) };
  }
  if (request.headers.get("origin") === DESKTOP_APP_ORIGIN &&
      (!desktopReviewAnalysisEnabled() || desktopConversationWriteProduct(conversation) !== "review")) {
    return { response: jsonError("Review analysis is unavailable.", "REVIEW_ANALYSIS_UNAVAILABLE", 403) };
  }
  if (
    !hasConversationUnlockGrant(
      request,
      userId,
      conversationId,
      conversation.password == null ? null : conversation.passwordVersion
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

/** The saved-result DTO both read-only lookups return. Nothing is spent. */
const storedReviewPayload = (
  stored: { id: string; reviewerModelId: string; usageCredits: number },
  result: z.infer<typeof dualComparisonReviewResultSchema>,
  responseMap: NonNullable<ReturnType<typeof responseMapForStoredReview>>
) => ({
  id: stored.id,
  result,
  reviewItems: reviewItemIds(result),
  responseMap,
  reviewerModelId: stored.reviewerModelId,
  usageCredits: 0,
  originalUsageCredits: stored.usageCredits,
  cached: true,
  disclaimer: "This AI review compares supplied answers and is not external fact verification.",
});

/**
 * The saved result of one exact turn, for a client waiting on a run that is
 * already in flight.
 *
 * It answers only for the turn it was asked about. A turn that no longer
 * resolves (an answer deleted or regenerated) is COMPARISON_REVIEW_TURN_NOT_FOUND,
 * never the latest turn's review: substituting one would show a waiting
 * client somebody else's question as the result of its own run. It is also
 * independent of the latest turn -- a newer question still generating, or one
 * over the size limit, does not hide an older turn's saved result -- and it
 * skips the size check, which guards reviewer input and this reads a row.
 *
 * `savedBefore` is the row's `updatedAt` as the refused POST read it *after*
 * its claim was refused ("none" when there was no row). The comparison is the
 * column against its own earlier value: Prisma fills `updatedAt` from the
 * application's clock, so comparing it with the claim's database `NOW()`
 * would compare two clocks. Liveness is read before the row -- a run writes
 * its row before it releases its claim -- and then:
 *
 *   no row                        live: pending  | not live: ended
 *   row, savedBefore none         saved
 *   row, updatedAt differs        saved          (written since the join)
 *   row, updatedAt equal          live: pending  (the run has not written)
 *                                 not live, fresh: saved (this input's valid
 *                                   result was already saved at the join: the
 *                                   runner saved but had not released, or it
 *                                   was a cache hit; a POST returns it too)
 *                                 not live, stale: ended (the previous result
 *                                   the run was replacing; never handed out)
 *
 * A row that fails to parse or map is never saved; it falls to pending or
 * ended by liveness. `isStale` alone is no reason to withhold a row written
 * since the join: saving any further answer to the same question marks that
 * question's reviews stale (the chat route), so a third answer finishing just
 * after a 2-answer run saved would otherwise hide the result. The input hash
 * is recomputed from the messages as they are now, so any row it finds
 * reviews exactly these question and answer texts.
 *
 * One narrow case reads "ended" although a result exists: the runner saved,
 * the row was marked stale, and the duplicate arrived before the release. The
 * duplicate then fingerprints a stale row that will not change again, so the
 * wait ends without showing it. That is a missed result, never a wrong one;
 * the user can open or run the review again.
 */
const storedTurnReviewResponse = async (
  userId: string,
  conversationId: string,
  lookup: StoredTurnLookup
) => {
  const turn = await requestedComparableConversationTurn(
    conversationId,
    lookup.promptMessageId,
    lookup.assistantMessageIds
  );
  if (!turn) {
    return jsonError(
      "The answers this review was running on are no longer available.",
      COMPARISON_REVIEW_TURN_NOT_FOUND,
      404
    );
  }
  const inputHash = createComparisonReviewHash({
    promptMessageId: turn.prompt.id,
    question: turn.prompt.content,
    responses: turn.responses,
    reviewMode: lookup.reviewMode,
    includeSynthesis: lookup.includeSynthesis,
  });
  const running = await isInFlightRunLive(
    getUserChatUsageKey(userId),
    "comparison-review",
    inputHash,
    COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS
  );
  const stored = await prisma.comparisonReview.findUnique({
    where: { userId_inputHash: { userId, inputHash } },
  });
  const unchangedSinceJoin = stored !== null &&
    lookup.savedBefore !== COMPARISON_REVIEW_SAVED_BEFORE_NONE &&
    stored.updatedAt.toISOString() === lookup.savedBefore;
  const acceptable = stored !== null && (
    !unchangedSinceJoin || (!running && !stored.isStale)
  );
  const parsed = stored && acceptable ? dualComparisonReviewResultSchema.safeParse(stored.result) : null;
  const responseMap = stored && acceptable ? responseMapForStoredReview(stored.assistantMessageIds, turn.responses) : null;
  const source = {
    question: turn.prompt.content,
    responses: turn.responses.map(({ messageId, content }) => ({ messageId, content })),
  };
  const storedReview = stored && parsed?.success && responseMap
    ? storedReviewPayload(stored, parsed.data, responseMap)
    : null;
  return Response.json(
    { available: true, source, storedReview, running: storedReview ? false : running },
    { headers: { "Cache-Control": "no-store" } }
  );
};

/**
 * The 409 a duplicate gets. `savedBefore` is the row as read *after* the
 * claim was refused -- its `updatedAt` whether it is fresh or stale, or null
 * when there is none -- so it describes the row at a moment the joined run
 * was already holding the claim. A read before the claim attempt could see a
 * row that turned stale and was superseded by a run that claimed in between.
 * GET then decides what that row means (see storedTurnReviewResponse).
 */
const alreadyRunningResponse = (
  current: { updatedAt: Date } | null,
  traceId: string
) =>
  Response.json(
    {
      error: "This request is already being processed.",
      code: "DUPLICATE_REQUEST",
      savedBefore: current ? current.updatedAt.toISOString() : null,
      traceId,
    },
    { status: 409, headers: { "Cache-Control": "no-store" } }
  );

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
    if (!session?.user?.id) {
      return jsonError("Authentication required.", "AUTH_REQUIRED", 401);
    }
    const query = new URL(request.url).searchParams;
    // A client waiting on a run already in flight (POST answered 409
    // DUPLICATE_REQUEST) names that run's exact turn. Those lookups count
    // against their own bucket, so a long wait cannot exhaust the budget the
    // setup preview below needs.
    const exactTurnLookup =
      query.has("promptMessageId") || query.has("assistantMessageIds");
    const exactLookup = exactTurnLookup ? parseStoredTurnLookup(query) : null;
    // A malformed lookup is refused before it spends anything, the rate limit
    // included.
    if (exactTurnLookup && !exactLookup) {
      return jsonError("Invalid saved-review lookup.", "INVALID_COMPARISON_REVIEW_LOOKUP", 400);
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      exactTurnLookup ? COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_SCOPE : "comparison-review-preview",
      exactTurnLookup ? COMPARISON_REVIEW_IN_FLIGHT_LOOKUP_RATE_LIMIT : { minute: 20, day: 300 }
    );
    const { conversationId } = await context.params;
    const authorization = await authorizeConversation(
      request,
      session.user.id,
      conversationId
    );
    if ("response" in authorization) return authorization.response;
    if (exactLookup) {
      return storedTurnReviewResponse(session.user.id, conversationId, exactLookup);
    }

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
    const source = {
      question: turn.prompt.content,
      responses: turn.responses.map(({ messageId, content }) => ({ messageId, content })),
    };
    // Read-only recovery never dispatches a reviewer or reserves credits.
    const requestedMode = comparisonReviewModeSchema.safeParse(query.get("reviewMode"));
    if (requestedMode.success) {
      const inputHash = createComparisonReviewHash({ promptMessageId: turn.prompt.id, question: turn.prompt.content, responses: turn.responses, reviewMode: requestedMode.data, includeSynthesis: query.get("includeSynthesis") === "true" });
      const stored = await prisma.comparisonReview.findUnique({ where: { userId_inputHash: { userId: session.user.id, inputHash } } });
      const parsed = stored && !stored.isStale ? dualComparisonReviewResultSchema.safeParse(stored.result) : null;
      const responseMap = stored ? responseMapForStoredReview(stored.assistantMessageIds, turn.responses) : null;
      if (stored && parsed?.success && responseMap) return Response.json({ available: true, source, storedReview: storedReviewPayload(stored, parsed.data, responseMap) }, { headers: { "Cache-Control": "no-store" } });
    }
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
        source,
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
  return withReviewProgress(request, publish => runPost(request, context, publish));
}

async function runPost(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
  publish: PublishReviewProgress,
): Promise<Response> {
  const traceId = randomUUID();
  let freeQuota: ComparisonReviewQuotaReservation | null = null;
  let runClaim: InFlightRunClaim | null = null;
  let completed = false;
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
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
    if ("response" in authorization) return authorization.response ?? jsonError("Authentication required.", "AUTH_REQUIRED", 401, traceId);
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
    // One run per (account, input) at a time. The row below is written only
    // when the reviewers finish, so until then the cache cannot see a run in
    // flight: a second tab, a retry after a dropped stream, or Studio and the
    // Classic dialog both asking used to run and bill the whole review again
    // and reserve a second Free slot. Claimed before the cache read so a run
    // that finishes between the two is still served from its row, and before
    // the quota so a duplicate spends nothing. The loser gets 409
    // DUPLICATE_REQUEST and waits for the saved result through GET. Released
    // in `finally` on every outcome; it expires on its own if this process
    // dies first (lib/comparisonReviewInFlight.ts derives the TTL).
    try {
      runClaim = await claimInFlightRun(
        getUserChatUsageKey(session.user.id),
        "comparison-review",
        inputHash,
        COMPARISON_REVIEW_IN_FLIGHT_TTL_SECONDS
      );
    } catch (error) {
      if (!(error instanceof ChatAccessError && error.code === "DUPLICATE_REQUEST")) throw error;
      // Read only now, after the refusal, while the joined run holds the
      // claim (see alreadyRunningResponse).
      const current = await prisma.comparisonReview.findUnique({
        where: {
          userId_inputHash: { userId: session.user.id, inputHash },
        },
        select: { updatedAt: true },
      });
      return alreadyRunningResponse(current, traceId);
    }
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
          onPrimary: primary => publish({ ...primary, persisted: false, cached: false }),
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
    if (runClaim) {
      // After a success the saved row answers the next request; after a
      // failure the user may genuinely retry. A release that fails leaves the
      // claim to expire on its own.
      await releaseInFlightRun(runClaim).catch((error) =>
        console.error("Comparison review run claim release failed:", {
          traceId,
          error,
        })
      );
    }
  }
}
