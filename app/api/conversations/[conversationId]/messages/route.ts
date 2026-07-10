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
    message: "Unsupported model.",
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
          return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
      }

      const session = await getServerSession(authOptions);
      if (!session || !session.user) {
          return NextResponse.json({ error: "Authentication required." }, { status: 401 });
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
          return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
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
    console.error("Failed to save messages:", error);
    return NextResponse.json(
      { error: "Failed to save messages." },
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
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
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
            return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
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
            return NextResponse.json({ error: "Missing required parameter." }, { status: 400 });
        }
        const parsedModelId = modelIdSchema.safeParse(modelId);
        if (!parsedModelId.success) {
            return NextResponse.json({ error: "Unsupported model." }, { status: 400 });
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

    console.error("Failed to delete messages:", error);
    return NextResponse.json({ error: "Failed to delete messages." }, { status: 500 });
  }
}
