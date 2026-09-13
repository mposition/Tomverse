export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  chatComposerDraftDeleteSchema,
  chatComposerDraftPutSchema,
  chatDraftScopeKeySchema,
  validateDraftReferencesForScope,
} from "@/lib/chatComposerDraftCore";
import {
  ChatDraftRevisionConflictError,
  deleteChatComposerDraft,
  publicChatComposerDraftWithAttachments,
  readPublicChatComposerDraft,
  writeChatComposerDraft,
} from "@/lib/chatComposerDraftPersistence";
import { authorizeChatRecoveryScope } from "@/lib/chatDurableRecoveryAccess";
import { MessageAttachmentResolveError } from "@/lib/messageAttachmentStorage";

type Params = { params: Promise<{ scopeKey: string }> };
type RequestScope =
  | { response: Response }
  | { userId: string; userEmail: string | null | undefined; scopeKey: string };

const jsonError = (error: string, code: string, status: number, extra?: object) =>
  Response.json(
    { error, code, ...extra },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );

const noStore = (response: Response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

async function requestScope(
  request: Request,
  params: Params["params"],
  rateLimit: { operation: string; minute: number; day: number }
): Promise<RequestScope> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return { response: jsonError("Authentication required.", "AUTH_REQUIRED", 401) };
  }
  const parsed = chatDraftScopeKeySchema.safeParse((await params).scopeKey);
  if (!parsed.success) {
    return { response: jsonError("Invalid Chat draft scope.", "CHAT_DRAFT_INVALID", 400) };
  }
  await consumeApiRateLimit(request, session.user.id, rateLimit.operation, {
    minute: rateLimit.minute,
    day: rateLimit.day,
  });
  const access = await authorizeChatRecoveryScope({
    request,
    userId: session.user.id,
    scopeKey: parsed.data,
  });
  if (!access.ok) return { response: access.response };
  return {
    userId: session.user.id,
    userEmail: session.user.email,
    scopeKey: parsed.data,
  };
}

export async function GET(request: Request, { params }: Params) {
  try {
    const scope = await requestScope(request, params, {
      operation: "chat-draft-read",
      minute: 120,
      day: 4_000,
    });
    if ("response" in scope) return noStore(scope.response);
    const draft = await readPublicChatComposerDraft({
      userId: scope.userId,
      userEmail: scope.userEmail,
      scopeKey: scope.scopeKey,
    });
    return Response.json(
      { scopeKey: scope.scopeKey, draft },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return noStore(securityResponse);
    console.error("Chat draft read failed:", error);
    return jsonError("Failed to read the Chat draft.", "CHAT_DRAFT_READ_FAILED", 500);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const scope = await requestScope(request, params, {
      operation: "chat-draft-write",
      minute: 60,
      day: 2_000,
    });
    if ("response" in scope) return noStore(scope.response);
    const body = await readLimitedJson(request, 220 * 1024, chatComposerDraftPutSchema);
    if (!validateDraftReferencesForScope(scope.scopeKey, body.attachmentReferences)) {
      return jsonError(
        "A new Chat draft may reference completed uploads only.",
        "CHAT_DRAFT_INVALID",
        400
      );
    }
    let draft;
    try {
      const written = await writeChatComposerDraft({
        userId: scope.userId,
        userEmail: scope.userEmail,
        scopeKey: scope.scopeKey,
        draft: body,
      });
      draft = await publicChatComposerDraftWithAttachments({
        userId: scope.userId,
        userEmail: scope.userEmail,
        draft: written,
      });
    } catch (error) {
      if (error instanceof ChatDraftRevisionConflictError) {
        const currentDraft = await readPublicChatComposerDraft({
          userId: scope.userId,
          userEmail: scope.userEmail,
          scopeKey: scope.scopeKey,
        });
        return jsonError(error.message, error.code, 409, {
          currentRevision: currentDraft?.revision ?? null,
          currentDraft,
        });
      }
      throw error;
    }
    return Response.json(
      { draft },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("Invalid Chat draft.", "CHAT_DRAFT_INVALID", 400);
    }
    if (
      error instanceof MessageAttachmentResolveError ||
      (error instanceof Error && error.message === "CHAT_DRAFT_ATTACHMENT_ACCOUNT_ADDRESS_REQUIRED")
    ) {
      return jsonError("A draft attachment is not available.", "CHAT_DRAFT_ATTACHMENT_INVALID", 400);
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return noStore(securityResponse);
    console.error("Chat draft write failed:", error);
    return jsonError("Failed to save the Chat draft.", "CHAT_DRAFT_WRITE_FAILED", 500);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const scope = await requestScope(request, params, {
      operation: "chat-draft-write",
      minute: 60,
      day: 2_000,
    });
    if ("response" in scope) return noStore(scope.response);
    const body = await readLimitedJson(request, 1024, chatComposerDraftDeleteSchema);
    try {
      await deleteChatComposerDraft({
        userId: scope.userId,
        scopeKey: scope.scopeKey,
        expectedRevision: body.expectedRevision,
      });
    } catch (error) {
      if (error instanceof ChatDraftRevisionConflictError) {
        const currentDraft = await readPublicChatComposerDraft({
          userId: scope.userId,
          userEmail: scope.userEmail,
          scopeKey: scope.scopeKey,
        });
        return jsonError(error.message, error.code, 409, {
          currentRevision: currentDraft?.revision ?? null,
          currentDraft,
        });
      }
      throw error;
    }
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError("Invalid Chat draft deletion.", "CHAT_DRAFT_INVALID", 400);
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return noStore(securityResponse);
    console.error("Chat draft deletion failed:", error);
    return jsonError("Failed to delete the Chat draft.", "CHAT_DRAFT_DELETE_FAILED", 500);
  }
}
