export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import {
  runComparisonReview,
  ComparisonReviewerUnavailableError,
  ComparisonReviewFailedError,
} from "@/lib/comparisonReviewService";
import {
  getGuestComparisonReviewLimit,
  releaseComparisonReviewQuota,
  reserveGuestComparisonReview,
  type ComparisonReviewQuotaReservation,
} from "@/lib/comparisonReviewQuota";
import {
  claimGuestIdempotencyKey,
  releaseGuestIdempotencyKey,
  type GuestIdempotencyClaim,
} from "@/lib/guestIdempotency";
import {
  assertGuestReviewInputSize,
  guestComparisonReviewRunSchema,
  resolveGuestReviewResponses,
  GUEST_COMPARISON_REVIEW_MAX_BODY_BYTES,
} from "@/lib/guestComparisonReview";
import { chatErrorResponse, identifyChatCaller } from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { ensureGuestVerified } from "@/lib/turnstile";

/**
 * Guest AI cross-review.
 *
 * The counterpart to `POST /api/conversations/:id/comparison-reviews`, and
 * deliberately *only* that: the review itself is the shared pipeline in
 * `lib/comparisonReviewService`, byte for byte the one a signed-in user gets,
 * including the two independent reviewers and the source-grounding
 * verification. What lives here is the guest-shaped part -- who is allowed in,
 * which quota is spent, and the fact that nothing is persisted afterwards.
 *
 * Order matters, and it is fail-closed at every step:
 *
 *   1. guest identity (the existing signed cookie -- no new fingerprinting)
 *   2. per-subject and per-IP rate limit
 *   3. bounded, schema-validated payload
 *   4. Turnstile (or an unexpired grant from an earlier challenge)
 *   5. idempotency claim -- so a double click loses here, before any spend
 *   6. monthly trial quota, reserved atomically
 *   7. credits reserved and settled per reviewer inside the shared service
 *
 * Steps 5 and 6 are both released if the run produces no result, so a provider
 * outage costs the guest neither their trial nor their credits.
 */
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

export async function POST(request: Request) {
  const traceId = randomUUID();
  let quota: ComparisonReviewQuotaReservation | null = null;
  let idempotency: GuestIdempotencyClaim | null = null;
  let completed = false;
  try {
    const access = identifyChatCaller(request);
    if (access.kind !== "guest") {
      // Signed-in users have a conversation to review against, a plan quota
      // and a persisted result. Letting them in here would give them a second,
      // quota-free path to the same paid feature.
      return jsonError(
        "This endpoint is for guest sessions only.",
        "GUEST_ONLY_ENDPOINT",
        400,
        traceId
      );
    }

    await consumeApiRateLimit(
      request,
      access.subjectKey,
      "guest-comparison-review",
      { minute: 2, day: 6 }
    );

    const body = await readLimitedJson(
      request,
      GUEST_COMPARISON_REVIEW_MAX_BODY_BYTES,
      guestComparisonReviewRunSchema
    );
    const responses = resolveGuestReviewResponses(body.responses);
    assertGuestReviewInputSize(body.question, responses);

    const turnstileGrantCookie = await ensureGuestVerified(
      request,
      body.turnstileToken,
      "guest_ai_review"
    );

    // Claimed before the quota so a duplicate request never reaches the
    // quota's own conditional upsert -- two clicks must consume one trial, not
    // two, and must run one review, not two.
    idempotency = await claimGuestIdempotencyKey(
      access.subjectKey,
      "comparison-review",
      body.idempotencyKey
    );
    quota = await reserveGuestComparisonReview(access.subjectKey);

    const run = await runComparisonReview(
      { access, reviewerPlan: "Free" },
      {
        question: body.question,
        responses,
        reviewMode: body.reviewMode,
        includeSynthesis: body.includeSynthesis,
        language: body.language || "en",
      },
      { traceId }
    );
    completed = true;

    const headers = new Headers({ "Cache-Control": "no-store" });
    if (access.setCookie) headers.append("Set-Cookie", access.setCookie);
    if (turnstileGrantCookie) headers.append("Set-Cookie", turnstileGrantCookie);

    // The same DTO shape the signed-in route returns, minus the fields that
    // only exist because that one persists: no row id, no createdAt. `guest`
    // and `persisted` let the dialog say plainly that this result lives for
    // this session only, instead of dressing it up as saved.
    return Response.json(
      {
        guest: true,
        persisted: false,
        result: run.result,
        responseMap: run.responseMap,
        reviewerModelId: run.reviewerModelId,
        usageCredits: run.usageCredits,
        cached: false,
        webVerificationAvailable: false,
        guestTrial: { limit: getGuestComparisonReviewLimit(), remaining: 0 },
        disclaimer:
          "This AI review compares supplied answers and is not external fact verification.",
      },
      { headers }
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "COMPARISON_REVIEW_INPUT_TOO_LARGE"
    ) {
      return jsonError(
        "The responses are too long for one guest review.",
        "COMPARISON_REVIEW_INPUT_TOO_LARGE",
        413,
        traceId
      );
    }
    if (error instanceof ComparisonReviewerUnavailableError) {
      return jsonError(
        "No comparison reviewer is currently configured.",
        "COMPARISON_REVIEWER_UNAVAILABLE",
        503,
        traceId
      );
    }
    if (error instanceof ComparisonReviewFailedError) {
      console.error("All guest comparison reviewers failed:", { traceId });
      return jsonError(
        "The AI review could not be completed. Reserved credits were refunded.",
        "COMPARISON_REVIEW_FAILED",
        502,
        traceId
      );
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    // Nothing from the provider, and nothing from the payload, reaches the
    // client: only this route's own trace id does.
    console.error("Guest comparison review failed:", { traceId, error });
    return jsonError(
      "Failed to create the AI review.",
      "COMPARISON_REVIEW_FAILED",
      500,
      traceId
    );
  } finally {
    if (!completed) {
      // A run that produced no result must cost neither the monthly trial nor
      // the right to try again.
      if (quota) {
        await releaseComparisonReviewQuota(quota).catch((error) =>
          console.error("Guest review quota refund failed:", { traceId, error })
        );
      }
      if (idempotency) {
        await releaseGuestIdempotencyKey(idempotency).catch((error) =>
          console.error("Guest review idempotency release failed:", {
            traceId,
            error,
          })
        );
      }
    }
  }
}
