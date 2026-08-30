export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { dualComparisonReviewResultSchema } from "@/lib/comparisonReview";
import {
  COMPARISON_REVIEW_ITEM_VERDICTS,
  isKnownComparisonReviewItem,
  sectionOfItemId,
} from "@/lib/comparisonReviewItemFeedback";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

/**
 * The user's own verdict on one claim inside one AI Review.
 *
 * docs/policy/ai-review-m5-quality-contract.md §9.
 *
 * Deliberately its own endpoint rather than a field on the review: the review
 * is immutable once written (its `inputHash` is its identity), and a verdict
 * is a second, later, per-person fact about it.
 *
 * Three properties the shape of this route is chosen for:
 *
 *   * **Idempotent.** The unique (review, user, item) index is the
 *     idempotency key, so a double click updates one row rather than writing
 *     two, and re-sending the same verdict is a no-op.
 *   * **Reversible.** A user may change their mind (PUT again) or take the
 *     verdict back entirely (DELETE). A feedback control the user cannot undo
 *     is a control people stop using.
 *   * **Never a quality verdict.** One "incorrect" is one person's opinion of
 *     one claim -- they may have misread it, disagreed with a correct one, or
 *     been right. Nothing here marks the reviewer wrong; the aggregate is a
 *     signal that tells a person where to look.
 *
 * Guests are refused, and not by an oversight: a guest AI Review is never
 * persisted, so there is no review row for a verdict to point at. Storing one
 * would mean storing the guest's review in order to hold their opinion of it.
 */

const bodySchema = z
  .object({
    reviewId: z.string().min(1).max(64),
    reviewItemId: z.string().min(1).max(128),
    verdict: z.enum(COMPARISON_REVIEW_ITEM_VERDICTS),
  })
  .strict();

const deleteSchema = z
  .object({
    reviewId: z.string().min(1).max(64),
    reviewItemId: z.string().min(1).max(128),
  })
  .strict();

const jsonError = (error: string, code: string, status: number) =>
  Response.json(
    { error, code },
    { status, headers: { "Cache-Control": "no-store" } }
  );

/**
 * Resolves the review this verdict is about, scoped to the caller.
 *
 * `userId` is inside the `where`, not compared afterwards: somebody else's
 * review is "not found" and there is no branch that could report the
 * difference.
 */
const authorizeReview = async (
  request: Request,
  userId: string,
  conversationId: string,
  reviewId: string
) => {
  const review = await prisma.comparisonReview.findFirst({
    where: { id: reviewId, userId, conversationId },
    select: { id: true, result: true },
  });
  if (!review) {
    return { response: jsonError("Review not found.", "NOT_FOUND", 404) };
  }
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { password: true },
  });
  if (!conversation) {
    return { response: jsonError("Review not found.", "NOT_FOUND", 404) };
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
  return { review };
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
      "comparison-review-item-feedback-read",
      { minute: 60, day: 600 }
    );
    const { conversationId } = await context.params;
    const reviewId = new URL(request.url).searchParams.get("reviewId") || "";
    if (!reviewId) {
      return jsonError(
        "reviewId is required.",
        "INVALID_ITEM_FEEDBACK_REQUEST",
        400
      );
    }
    const authorization = await authorizeReview(
      request,
      session.user.id,
      conversationId,
      reviewId
    );
    if ("response" in authorization) return authorization.response;

    const rows = await prisma.comparisonReviewItemFeedback.findMany({
      where: { comparisonReviewId: reviewId, userId: session.user.id },
      select: { reviewItemId: true, verdict: true },
    });
    return Response.json(
      { feedback: rows },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Comparison review item feedback read failed:", error);
    return jsonError(
      "Failed to load review feedback.",
      "ITEM_FEEDBACK_READ_FAILED",
      500
    );
  }
}

export async function PUT(
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
      "comparison-review-item-feedback",
      { minute: 30, day: 300 }
    );
    const { conversationId } = await context.params;
    const payload = await readLimitedJson(request, 4 * 1024, bodySchema);
    const authorization = await authorizeReview(
      request,
      session.user.id,
      conversationId,
      payload.reviewId
    );
    if ("response" in authorization) return authorization.response;

    const parsed = dualComparisonReviewResultSchema.safeParse(
      authorization.review.result
    );
    if (!parsed.success) {
      return jsonError(
        "This review cannot accept feedback.",
        "REVIEW_RESULT_UNREADABLE",
        409
      );
    }
    // The client's item id is never trusted. An id matching no claim in this
    // review is refused rather than stored, so the table cannot accumulate
    // rows pointing at claims that do not exist -- and cannot be used as free
    // storage.
    if (
      !isKnownComparisonReviewItem(
        {
          primary: parsed.data.primary.result,
          secondary: parsed.data.secondary?.result ?? null,
        },
        payload.reviewItemId
      )
    ) {
      return jsonError(
        "That review item does not exist.",
        "UNKNOWN_REVIEW_ITEM",
        400
      );
    }
    const section = sectionOfItemId(payload.reviewItemId);
    if (!section) {
      return jsonError(
        "That review item does not exist.",
        "UNKNOWN_REVIEW_ITEM",
        400
      );
    }

    // The unique index is the idempotency key: a double click updates one row
    // rather than writing two.
    await prisma.comparisonReviewItemFeedback.upsert({
      where: {
        comparisonReviewId_userId_reviewItemId: {
          comparisonReviewId: payload.reviewId,
          userId: session.user.id,
          reviewItemId: payload.reviewItemId,
        },
      },
      create: {
        comparisonReviewId: payload.reviewId,
        userId: session.user.id,
        reviewItemId: payload.reviewItemId,
        section,
        verdict: payload.verdict,
      },
      update: { verdict: payload.verdict, section },
    });

    return Response.json(
      { verdict: payload.verdict },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(
        "Invalid review feedback request.",
        "INVALID_ITEM_FEEDBACK_REQUEST",
        400
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Comparison review item feedback failed:", error);
    return jsonError(
      "Failed to save review feedback.",
      "ITEM_FEEDBACK_FAILED",
      500
    );
  }
}

export async function DELETE(
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
      "comparison-review-item-feedback",
      { minute: 30, day: 300 }
    );
    const { conversationId } = await context.params;
    const payload = await readLimitedJson(request, 4 * 1024, deleteSchema);
    const authorization = await authorizeReview(
      request,
      session.user.id,
      conversationId,
      payload.reviewId
    );
    if ("response" in authorization) return authorization.response;

    // deleteMany, not delete: withdrawing a verdict that is already gone is
    // the same outcome the caller asked for, and a 404 would make an
    // idempotent retry look like a failure.
    await prisma.comparisonReviewItemFeedback.deleteMany({
      where: {
        comparisonReviewId: payload.reviewId,
        userId: session.user.id,
        reviewItemId: payload.reviewItemId,
      },
    });
    return Response.json(
      { verdict: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(
        "Invalid review feedback request.",
        "INVALID_ITEM_FEEDBACK_REQUEST",
        400
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Comparison review item feedback withdrawal failed:", error);
    return jsonError(
      "Failed to withdraw review feedback.",
      "ITEM_FEEDBACK_FAILED",
      500
    );
  }
}
