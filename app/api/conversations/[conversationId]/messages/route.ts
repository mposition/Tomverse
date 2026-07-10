import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { z } from "zod";
import { isEnabledModelId } from "@/lib/models";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
  apiSecurityResponse,
  assertMessageCapacity,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const modelIdSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isEnabledModelId, {
    message: "ì§€ì›í•˜ì§€ ì•ŠëŠ” ëª¨ë¸ìž…ë‹ˆë‹¤.",
  });
const userMessageSchema = z
  .object({
    id: z.string().uuid(),
    role: z.literal("user"),
    content: z.string().trim().min(1).max(50_000),
    status: z.literal("normal").optional().default("normal"),
    modelId: modelIdSchema.optional(),
  })
  .strict();
const saveMessagesSchema = z
  .object({
    messages: z.array(userMessageSchema).min(1).max(3),
  })
  .strict();

export async function POST(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/messages">
) {
  try {
	const params = await context.params;
      const conversationId = params.conversationId;

      if (!conversationId) {
          return NextResponse.json({ error: "ëŒ€í™”ë°© IDê°€ ëˆ„ë½ë˜ì—ˆìŠµë‹ˆë‹¤." }, { status: 400 });
      }

      const session = await getServerSession(authOptions);
      if (!session || !session.user) {
          return NextResponse.json({ error: "ê¶Œí•œì´ ì—†ìŠµë‹ˆë‹¤." }, { status: 401 });
      }

      const userId = session.user.id;
      await consumeApiRateLimit(req, userId, "message-save", {
        minute: 30,
        day: 1_000,
      });
      const existingConv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, password: true }
      });

      if (!existingConv || existingConv.userId !== userId) {
          return NextResponse.json({ error: "íƒ€ì¸ì˜ ëŒ€í™”ë°©ì— ë©”ì‹œì§€ë¥¼ ì¡°ìž‘í•  ìˆ˜ ì—†ìŠµë‹ˆë‹¤." }, { status: 403 });
      }
      if (
        !hasConversationUnlockGrant(
          req,
          userId,
          conversationId,
          existingConv.password
        )
      ) {
        return conversationLockedResponse();
      }

    const body = await readLimitedJson(req, 160 * 1024, saveMessagesSchema);
    const contentBytes = body.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, "utf8"),
      0
    );
    const created = await prisma.$transaction(async (tx) => {
      await assertMessageCapacity(
        tx,
        userId,
        conversationId,
        body.messages.length,
        contentBytes
      );
      return tx.message.createMany({
        data: body.messages.map((message) => ({
          id: message.id,
          conversationId,
          role: "user",
          content: message.content,
          status: "normal",
          modelId: message.modelId || null,
        })),
        skipDuplicates: true,
      });
    });

    return NextResponse.json({ success: true, created: created.count });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("âŒ ë©”ì‹œì§€ ì €ìž¥ ì—ëŸ¬:", error);
    return NextResponse.json(
      { error: "ë©”ì‹œì§€ ì €ìž¥ ì‹¤íŒ¨" },
      { status: 500 }
    );
  }
}

export async function DELETE(
    req: Request,
    context: RouteContext<"/api/conversations/[conversationId]/messages">
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session || !session.user) {
            return NextResponse.json({ error: "ê¶Œí•œì´ ì—†ìŠµë‹ˆë‹¤." }, { status: 401 });
        }

        const params = await context.params;
        const conversationId = params.conversationId;

        const userId = session.user.id;
        await consumeApiRateLimit(req, userId, "message-delete", {
          minute: 20,
          day: 200,
        });
        const existingConv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, password: true }
        });

        if (!existingConv || existingConv.userId !== userId) {
            return NextResponse.json({ error: "íƒ€ì¸ì˜ ëŒ€í™”ë°©ì— ë©”ì‹œì§€ë¥¼ ì¡°ìž‘í•  ìˆ˜ ì—†ìŠµë‹ˆë‹¤." }, { status: 403 });
        }
        if (
          !hasConversationUnlockGrant(
            req,
            userId,
            conversationId,
            existingConv.password
          )
        ) {
          return conversationLockedResponse();
        }

        const { searchParams } = new URL(req.url);
        const modelId = searchParams.get("modelId");

        if (!conversationId || !modelId) {
            return NextResponse.json({ error: "íŒŒë¼ë¯¸í„° ëˆ„ë½" }, { status: 400 });
        }
        const parsedModelId = modelIdSchema.safeParse(modelId);
        if (!parsedModelId.success) {
            return NextResponse.json({ error: "ì§€ì›í•˜ì§€ ì•ŠëŠ” ëª¨ë¸ìž…ë‹ˆë‹¤." }, { status: 400 });
        }

        await prisma.message.deleteMany({
            where: {
                conversationId: conversationId,
                modelId: parsedModelId.data,
                role: "assistant"
            }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("âŒ ë©”ì‹œì§€ ì‚­ì œ ì—ëŸ¬:", error);
    return NextResponse.json({ error: "ì‚­ì œ ì‹¤íŒ¨" }, { status: 500 });
  }
}
