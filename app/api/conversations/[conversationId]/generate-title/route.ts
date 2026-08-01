export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
  applyGeneratedTitle,
  generateConversationTitle,
  recordTitleGenerationUsage,
} from "@/lib/conversationTitle";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";

const requestSchema = z
  .object({
    expectedTitle: z.string().trim().min(1).max(120),
  })
  .strict();

const logRouteError = (event: string, traceId: string, error: unknown) => {
  console.error(
    JSON.stringify({
      event,
      traceId,
      ...safeErrorMetadata(error),
    })
  );
};

export async function POST(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/generate-title">
) {
  const traceId = randomUUID();
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }
    const userId = session.user.id;

    await consumeApiRateLimit(req, userId, "conversation-title-generate", {
      minute: 10,
      day: 50,
    });

    const body = await readLimitedJson(req, 8 * 1024, requestSchema);

    const params = await context.params;
    const conversationId = params.conversationId;
    if (!conversationId) {
      return NextResponse.json(
        { error: "Conversation ID is required." },
        { status: 400 }
      );
    }

    const existingConv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true },
    });
    if (!existingConv) {
      return NextResponse.json(
        { error: "Conversation not found." },
        { status: 404 }
      );
    }
    if (existingConv.userId !== userId) {
      return NextResponse.json(
        { error: "You do not have access to this conversation." },
        { status: 403 }
      );
    }
    if (
      existingConv.password &&
      !hasConversationUnlockGrant(req, userId, conversationId, existingConv.password)
    ) {
      return conversationLockedResponse();
    }

    const firstMessage = await prisma.message.findFirst({
      where: { conversationId, role: "user" },
      orderBy: { createdAt: "asc" },
      select: { content: true },
    });
    if (!firstMessage?.content) {
      return NextResponse.json({ updated: false, reason: "no_first_message" });
    }

    const generation = await generateConversationTitle(firstMessage.content);
    if (!generation.ok) {
      // Log the reason so a silent fall-back to the interim (truncated) title
      // is diagnosable from server logs rather than invisible.
      console.warn(
        JSON.stringify({
          event: "conversation_title_generation_failed",
          traceId,
          conversationId,
          reason: generation.reason,
        })
      );
      return NextResponse.json({ updated: false, reason: generation.reason });
    }

    const { updated } = await applyGeneratedTitle({
      conversationId,
      userId,
      expectedTitle: body.expectedTitle,
      newTitle: generation.title,
    });

    try {
      await recordTitleGenerationUsage(generation);
    } catch (error) {
      logRouteError("conversation_title_usage_record_failed", traceId, error);
    }

    return NextResponse.json({ updated, title: generation.title });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    logRouteError("conversation_title_generate_failed", traceId, error);
    // A title-generation failure must never surface as a user-facing error --
    // the client keeps its interim title either way.
    return NextResponse.json({ updated: false, reason: "provider_error" });
  }
}
