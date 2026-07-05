import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = {
  params: Promise<{
    conversationId: string;
  }>;
};

export async function POST(req: Request, { params }: Params) {
  try {
    const { conversationId } = await params;
    const body = await req.json();

    const messages = Array.isArray(body?.messages) ? body.messages : [];

    if (!messages.length) {
      return NextResponse.json(
        { error: "저장할 메시지가 없습니다." },
        { status: 400 }
      );
    }

	for (const msg of messages) {
	  // 유저의 질문은 중복 저장을 막기 위해 방 ID와 내용을 섞어 고유 ID를 생성합니다.
      const msgId = msg.id || (
        msg.role === "user" 
          ? `user-${conversationId}-${msg.content.slice(0, 20)}` 
          : crypto.randomUUID()
      );
	  
	  const isAssistant = msg.role === "assistant";
	  
      // 💡 유저 질문 중복 생성을 막고, 모델 ID를 꼬리표로 저장하기 위해 upsert 사용
      await prisma.message.upsert({
        where: { id: msgId },
        update: {
          content: msg.content,
          status: msg.status || "normal",
          modelId: isAssistant ? (msg.modelId || null) : null, // 업데이트 시에도 꼬리표 유지
        },
        create: {
          id: msgId,
          conversationId,
          role: msg.role,
          content: msg.content,
          status: msg.status || "normal",
          modelId: isAssistant ? (msg.modelId || null) : null, // 💡 꼬리표 달아서 생성!
        }
      });
    }

    // 새 메시지가 추가되었으니 대화방의 최근 업데이트 시간을 갱신합니다.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Message save error:", error);
    return NextResponse.json(
      { error: "메시지 저장 실패" },
      { status: 500 }
    );
  }
}