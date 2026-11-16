export const dynamic = "force-dynamic";

import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import {
  chatComposerDraftDeleteSchema,
  chatComposerDraftPutSchema,
  publicChatComposerDraft,
} from "@/lib/chatComposerDraftCore";
import {
  ChatDraftRevisionConflictError,
  deleteChatComposerDraft,
  readChatComposerDraft,
  writeChatComposerDraft,
} from "@/lib/chatComposerDraftPersistence";
import {
  authorizeReviewHandoffDraft,
  ReviewContinuationHandoffError,
} from "@/lib/reviewContinuationHandoffService";

const headers = { "Cache-Control": "private, no-store" };
const jsonError = (error: string, code: string, status: number, extra?: object) =>
  Response.json({ error, code, ...extra }, { status, headers });

async function scope(
  request: Request,
  context: RouteContext<"/api/conversations/[conversationId]/continuation/review-handoff/draft">,
  operation: string
) {
  const authentication = await resolveChatRouteSession(request);
  if (authentication.response) return { response: authentication.response } as const;
  const userId = authentication.session?.user?.id;
  if (!userId) return { response: jsonError("Authentication required.", "AUTH_REQUIRED", 401) } as const;
  await consumeApiRateLimit(request, userId, operation, { minute: 60, day: 2_000 });
  const { conversationId } = await context.params;
  await authorizeReviewHandoffDraft({ userId, conversationId, request });
  return { userId, userEmail: authentication.session?.user?.email, conversationId } as const;
}

const conflict = async (userId: string, conversationId: string, error: ChatDraftRevisionConflictError) => {
  const current = await readChatComposerDraft(userId, conversationId);
  return jsonError(error.message, error.code, 409, {
    currentRevision: current?.revision ?? null,
    currentDraft: current ? { ...publicChatComposerDraft(current), attachments: [] } : null,
  });
};

export async function GET(
  request: Request,
  context: RouteContext<"/api/conversations/[conversationId]/continuation/review-handoff/draft">
) {
  try {
    const authorized = await scope(request, context, "review-handoff-draft-read");
    if ("response" in authorized) return authorized.response;
    const row = await readChatComposerDraft(authorized.userId, authorized.conversationId);
    return Response.json({
      scopeKey: authorized.conversationId,
      draft: row ? { ...publicChatComposerDraft(row), attachments: [] } : null,
    }, { headers });
  } catch (error) {
    return routeError(error, "Failed to read the Review handoff draft.", "REVIEW_HANDOFF_DRAFT_READ_FAILED");
  }
}

export async function PUT(
  request: Request,
  context: RouteContext<"/api/conversations/[conversationId]/continuation/review-handoff/draft">
) {
  try {
    const authorized = await scope(request, context, "review-handoff-draft-write");
    if ("response" in authorized) return authorized.response;
    const body = await readLimitedJson(request, 220 * 1024, chatComposerDraftPutSchema);
    if (body.attachmentReferences.length > 0) {
      return jsonError(
        "Attachments are not supported in a Review continuation handoff.",
        "REVIEW_HANDOFF_ATTACHMENTS_UNSUPPORTED",
        400
      );
    }
    try {
      const row = await writeChatComposerDraft({
        userId: authorized.userId,
        userEmail: authorized.userEmail,
        scopeKey: authorized.conversationId,
        draft: body,
      });
      return Response.json({ draft: { ...publicChatComposerDraft(row), attachments: [] } }, { headers });
    } catch (error) {
      if (error instanceof ChatDraftRevisionConflictError) {
        return conflict(authorized.userId, authorized.conversationId, error);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid Review handoff draft.", "CHAT_DRAFT_INVALID", 400);
    return routeError(error, "Failed to save the Review handoff draft.", "REVIEW_HANDOFF_DRAFT_WRITE_FAILED");
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/conversations/[conversationId]/continuation/review-handoff/draft">
) {
  try {
    const authorized = await scope(request, context, "review-handoff-draft-write");
    if ("response" in authorized) return authorized.response;
    const body = await readLimitedJson(request, 1024, chatComposerDraftDeleteSchema);
    try {
      await deleteChatComposerDraft({
        userId: authorized.userId,
        scopeKey: authorized.conversationId,
        expectedRevision: body.expectedRevision,
      });
      return new Response(null, { status: 204, headers });
    } catch (error) {
      if (error instanceof ChatDraftRevisionConflictError) {
        return conflict(authorized.userId, authorized.conversationId, error);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid Review handoff draft deletion.", "CHAT_DRAFT_INVALID", 400);
    return routeError(error, "Failed to delete the Review handoff draft.", "REVIEW_HANDOFF_DRAFT_DELETE_FAILED");
  }
}

function routeError(error: unknown, fallback: string, code: string) {
  if (error instanceof ReviewContinuationHandoffError) {
    return jsonError(error.message, error.code, error.status);
  }
  const response = apiSecurityResponse(error);
  if (response) return response;
  console.error(code, error);
  return jsonError(fallback, code, 500);
}
