export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "conversation-search", {
      minute: 30,
      day: 1_000,
    });

    const q = new URL(req.url).searchParams.get("q")?.trim() || "";
    if (q.length < 2) {
      return NextResponse.json({ results: [] });
    }
    if (q.length > 80) {
      return NextResponse.json({ error: "Search query is too long." }, { status: 400 });
    }

    const messages = await prisma.message.findMany({
      where: {
        conversation: { userId: session.user.id },
        content: { contains: q, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        conversationId: true,
        content: true,
        role: true,
        modelId: true,
        conversation: { select: { title: true } },
      },
    });

    return NextResponse.json({
      results: messages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        conversationTitle: message.conversation.title,
        role: message.role,
        modelId: message.modelId,
        snippet:
          message.content.length > 180
            ? `${message.content.slice(0, 180)}...`
            : message.content,
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Conversation search failed:", error);
    return NextResponse.json({ error: "Search failed." }, { status: 500 });
  }
}
