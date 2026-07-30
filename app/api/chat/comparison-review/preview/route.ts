export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { GUEST_COMPARISON_REVIEW_LIMITS } from "@/lib/comparisonReview";
import {
  estimateComparisonReview,
  ComparisonReviewerUnavailableError,
} from "@/lib/comparisonReviewService";
import { getGuestComparisonReviewRemaining } from "@/lib/comparisonReviewQuota";
import {
  assertGuestReviewInputSize,
  guestComparisonReviewPreviewSchema,
  resolveGuestReviewResponses,
  GUEST_COMPARISON_REVIEW_MAX_BODY_BYTES,
} from "@/lib/guestComparisonReview";
import {
  chatErrorResponse,
  getGuestUsageSnapshot,
  identifyChatCaller,
} from "@/lib/chatSecurity";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

/**
 * The guest counterpart to `GET /api/conversations/:id/comparison-reviews`.
 *
 * It is a POST because the thing being previewed *is* the payload: a guest has
 * no saved conversation for the server to look the answers up in, so there is
 * nothing to name in a URL. It spends nothing, reserves nothing and calls no
 * provider -- it exists so the dialog can show a server-computed price, the
 * real reviewer class and the caller's actual remaining trial before anything
 * is committed.
 *
 * Everything a guest is shown about cost or quota originates here. Nothing is
 * read back from the client on the run.
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

    await consumeApiRateLimit(
      request,
      access.subjectKey,
      "guest-comparison-review-preview",
      { minute: 6, day: 40 }
    );

    const body = await readLimitedJson(
      request,
      GUEST_COMPARISON_REVIEW_MAX_BODY_BYTES,
      guestComparisonReviewPreviewSchema
    );
    const responses = resolveGuestReviewResponses(body.responses);
    assertGuestReviewInputSize(body.question, responses);

    const [estimate, trial, usage] = await Promise.all([
      estimateComparisonReview(
        { access, reviewerPlan: "Free" },
        { question: body.question, responses }
      ),
      getGuestComparisonReviewRemaining(access.subjectKey),
      getGuestUsageSnapshot(request),
    ]);

    const headers = new Headers({ "Cache-Control": "no-store" });
    if (access.setCookie) headers.append("Set-Cookie", access.setCookie);

    return Response.json(
      {
        available: true,
        guest: true,
        responses: responses.map((response) => ({
          messageId: response.messageId,
          modelId: response.modelId,
          modelName: response.modelName,
        })),
        estimatedCredits: estimate.estimatedCredits,
        dualReview: estimate.dualReview,
        reviewerClass: estimate.reviewerClass,
        reviewModes: ["balanced", "evidence", "action"],
        guestTrial: {
          limit: trial.limit,
          used: trial.used,
          remaining: trial.remaining,
        },
        creditsAvailable: usage.creditsAvailable,
        // Per-item web verification stays behind sign-in, so the result screen
        // can say so precisely instead of showing a control that 401s.
        webVerificationAvailable: false,
        // A guest review is never written to a ComparisonReview row (that
        // table's owner is a real user, and inventing one would make a
        // temporary trial into a permanent unowned record). The dialog states
        // this rather than presenting the result as saved.
        persisted: false,
        limits: {
          maxQuestionCharacters:
            GUEST_COMPARISON_REVIEW_LIMITS.maxQuestionCharacters,
          maxAnswerCharacters: GUEST_COMPARISON_REVIEW_LIMITS.maxAnswerCharacters,
          maxTotalCharacters: GUEST_COMPARISON_REVIEW_LIMITS.maxTotalCharacters,
        },
        disclaimer:
          "AI cross-review compares the supplied answers. It does not externally verify facts or search the web.",
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
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Guest comparison review preview failed:", { traceId, error });
    return jsonError(
      "Failed to prepare the comparison review.",
      "COMPARISON_REVIEW_PREVIEW_FAILED",
      500,
      traceId
    );
  }
}
