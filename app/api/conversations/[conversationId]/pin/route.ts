import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

/**
 * Pin or unpin one conversation.
 *
 * ## Why this is not part of the conversation PATCH
 *
 * `Conversation.updatedAt` is `@updatedAt`, and the sidebar groups its rows by
 * it (`lib/conversationListGrouping.ts`). Any Prisma `update` would therefore
 * move the conversation into 오늘 and tell its owner it was answered today --
 * from an action that answered nothing. So the column is written with raw SQL,
 * which touches exactly the column named here.
 *
 * The write is also scoped by `userId` in the statement itself rather than
 * after a read: somebody else's conversation is "not found", and there is no
 * branch that could report the difference.
 */

const pinSchema = z.object({ pinned: z.boolean() }).strict();

export async function PUT(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/pin">
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "conversation-pin", {
      minute: 60,
      day: 1000,
    });

    const { conversationId } = await context.params;
    if (!conversationId) {
      return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
    }

    const { pinned } = await readLimitedJson(req, 1024, pinSchema);

    const affected = pinned
      ? await prisma.$executeRaw`
          UPDATE "Conversation"
          SET "pinnedAt" = NOW()
          WHERE "id" = ${conversationId} AND "userId" = ${userId} AND "pinnedAt" IS NULL
        `
      : await prisma.$executeRaw`
          UPDATE "Conversation"
          SET "pinnedAt" = NULL
          WHERE "id" = ${conversationId} AND "userId" = ${userId} AND "pinnedAt" IS NOT NULL
        `;

    if (affected === 0) {
      // Either the row is not this account's, or it is already in the state
      // asked for. The second is not an error: a double tap, or two devices
      // agreeing, leaves the conversation exactly where the caller wanted it.
      const owned = await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        select: { pinnedAt: true },
      });
      if (!owned) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      return NextResponse.json({ pinned: owned.pinnedAt !== null });
    }

    return NextResponse.json({ pinned });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("Failed to update conversation pin:", error);
    return NextResponse.json({ error: "Failed to update the pin." }, { status: 500 });
  }
}
