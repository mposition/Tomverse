export const dynamic = "force-dynamic";

import { assertExternalContinuationEnabled, ExternalContinuationDisabledError } from "@/lib/appSettings";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { reviewHandoffCreateSchema } from "@/lib/reviewContinuationHandoffCore";
import {
  createReviewContinuationHandoff,
  ReviewContinuationHandoffError,
} from "@/lib/reviewContinuationHandoffService";

const noStore = { "Cache-Control": "private, no-store" };

export async function POST(
  request: Request,
  context: RouteContext<"/api/conversations/[conversationId]/continuation/review-handoff">
) {
  try {
    const authentication = await resolveChatRouteSession(request);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) {
      return Response.json({ error: "Authentication required.", code: "AUTH_REQUIRED" },
        { status: 401, headers: noStore });
    }
    await assertExternalContinuationEnabled();
    await consumeApiRateLimit(request, userId, "review-continuation-handoff-create", {
      minute: 10,
      day: 200,
    });
    const body = await readLimitedJson(request, 4 * 1024, reviewHandoffCreateSchema);
    const { conversationId } = await context.params;
    const result = await createReviewContinuationHandoff({
      userId,
      parentConversationId: conversationId,
      assistantMessageId: body.assistantMessageId,
      idempotencyKey: body.idempotencyKey,
      request,
    });
    return Response.json(result, {
      status: result.idempotentReplay ? 200 : 201,
      headers: noStore,
    });
  } catch (error) {
    if (error instanceof ExternalContinuationDisabledError) {
      return Response.json({ error: error.message, code: "EXTERNAL_CONTINUATION_DISABLED" },
        { status: 403, headers: noStore });
    }
    if (error instanceof ReviewContinuationHandoffError) {
      return Response.json({ error: error.message, code: error.code },
        { status: error.status, headers: noStore });
    }
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Review continuation handoff failed", error);
    return Response.json({ error: "Failed to prepare the Review comparison.", code: "REVIEW_HANDOFF_FAILED" },
      { status: 500, headers: noStore });
  }
}
