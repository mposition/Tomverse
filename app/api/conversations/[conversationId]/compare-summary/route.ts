export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getModel } from "@/lib/models";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";

const short = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 220);

export async function GET(
  req: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "compare-summary", {
      minute: 10,
      day: 100,
    });
    const { conversationId } = await context.params;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { userId: true, password: true, title: true },
    });
    if (!conversation || conversation.userId !== session.user.id) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    if (
      !hasConversationUnlockGrant(
        req,
        session.user.id,
        conversationId,
        conversation.password
      )
    ) {
      return conversationLockedResponse();
    }

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: "assistant",
        modelId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { modelId: true, content: true },
    });
    const byModel = new Map<string, string>();
    for (const message of messages) {
      if (message.modelId && !byModel.has(message.modelId)) {
        byModel.set(message.modelId, message.content);
      }
    }
    const items = Array.from(byModel.entries()).slice(0, 3).map(([modelId, content]) => ({
      modelId,
      modelName: getModel(modelId)?.name || modelId,
      summary: short(content),
    }));

    return NextResponse.json({
      title: conversation.title,
      items,
      note:
        items.length < 2
          ? "At least two model responses are needed to compare."
          : "This is a quick local comparison of the latest response from each model.",
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Compare summary failed:", error);
    return NextResponse.json({ error: "Failed to create comparison." }, { status: 500 });
  }
}
