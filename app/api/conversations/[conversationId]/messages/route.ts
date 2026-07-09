import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next"; // 💡 세션 검증 임포트 추가
import { authOptions } from "@/lib/auth";           // 💡 authOptions 임포트 추가
import { z } from "zod";
import { isEnabledModelId } from "@/lib/models";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";

const modelIdSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isEnabledModelId, {
    message: "지원하지 않는 모델입니다.",
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

type Params = {
  params: Promise<{
    conversationId: string;
  }>;
};

export async function POST(req: Request, context: any) {
  try {
	const params = await context.params;
      const conversationId = params.conversationId || params.id;

      if (!conversationId) {
          return NextResponse.json({ error: "대화방 ID가 누락되었습니다." }, { status: 400 });
      }

      // 🔒 [보안 강화] 일반 유저방일 경우 유효한 유저 세션이 있는지 검증합니다.
      const session = await getServerSession(authOptions);
      if (!session || !session.user) {
          return NextResponse.json({ error: "권한이 없습니다." }, { status: 401 });
      }

      const userId = (session.user as any).id;
      const existingConv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, password: true }
      });

      if (!existingConv || existingConv.userId !== userId) {
          return NextResponse.json({ error: "타인의 대화방에 메시지를 조작할 수 없습니다." }, { status: 403 });
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "잘못된 JSON 형식입니다.", code: "INVALID_JSON" },
        { status: 400 }
      );
    }
    const parsed = saveMessagesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "잘못된 메시지 형식입니다.",
          code: "INVALID_MESSAGE_PAYLOAD",
        },
        { status: 400 }
      );
    }

    const created = await prisma.message.createMany({
      data: parsed.data.messages.map((message) => ({
        id: message.id,
        conversationId,
        role: "user",
        content: message.content,
        status: "normal",
        modelId: message.modelId || null,
      })),
      skipDuplicates: true,
    });

    return NextResponse.json({ success: true, created: created.count });
  } catch (error) {
    console.error("❌ 메시지 저장 에러:", error);
    return NextResponse.json(
      { error: "메시지 저장 실패" },
      { status: 500 }
    );
  }
}

// 모델 전용 기록 삭제 API
export async function DELETE(req: Request, context: any) {
    try {
        const session = await getServerSession(authOptions);

        if (!session || !session.user) {
            return NextResponse.json({ error: "권한이 없습니다." }, { status: 401 });
        }

        const params = await context.params;
        const conversationId = params.conversationId || params.id;

        const userId = (session.user as any).id;
        const existingConv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, password: true }
        });

        if (!existingConv || existingConv.userId !== userId) {
            return NextResponse.json({ error: "타인의 대화방에 메시지를 조작할 수 없습니다." }, { status: 403 });
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

        // URL에서 modelId를 파싱해옵니다. (예: ?modelId=gpt-4o)
        const { searchParams } = new URL(req.url);
        const modelId = searchParams.get("modelId");

        if (!conversationId || !modelId) {
            return NextResponse.json({ error: "파라미터 누락" }, { status: 400 });
        }
        const parsedModelId = modelIdSchema.safeParse(modelId);
        if (!parsedModelId.success) {
            return NextResponse.json({ error: "지원하지 않는 모델입니다." }, { status: 400 });
        }

        // 해당 대화방에서 특정 모델이 작성한 'assistant' 메시지만 전부 삭제합니다.
        await prisma.message.deleteMany({
            where: {
                conversationId: conversationId,
                modelId: parsedModelId.data,
                role: "assistant"
            }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
    console.error("❌ 메시지 삭제 에러:", error);
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }
}
