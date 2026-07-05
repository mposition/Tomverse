import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = {
  params: Promise<{
    conversationId: string;
  }>;
};

export async function POST(req: Request, context: any) {
  try {
	const params = await context.params;
    const conversationId = params.conversationId || params.id;
    const body = await req.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];

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

    return NextResponse.json({ success: true });
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
    const params = await context.params;
    const conversationId = params.conversationId || params.id;
    
    // URL에서 modelId를 파싱해옵니다. (예: ?modelId=gpt-4o)
    const { searchParams } = new URL(req.url);
    const modelId = searchParams.get("modelId");

    if (!conversationId || !modelId) {
      return NextResponse.json({ error: "파라미터 누락" }, { status: 400 });
    }

    // 해당 대화방에서 특정 모델이 작성한 'assistant' 메시지만 전부 삭제합니다.
    await prisma.message.deleteMany({
      where: {
        conversationId: conversationId,
        modelId: modelId,
        role: "assistant"
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("❌ 메시지 삭제 에러:", error);
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }
}