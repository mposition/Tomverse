import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// 💡 방어 함수 추가
const safeParse = (data: any, fallback: any) => {
  if (!data) return fallback;
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    return fallback;
  }
};

type Params = {
  params: Promise<{
    conversationId: string;
  }>;
};

// 💡 특정 대화방의 상세 정보와 그 방에 쌓인 모든 메시지를 가져오는 GET 메서드
export async function GET(req: Request, { params }: Params) {
  try {
    const { conversationId } = await params;

    // Prisma의 include 기능을 사용해 대화방을 찾으면서 내부에 연결된 메시지까지 한 번에 쿼리합니다.
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc", // 💡 중요: 대화 흐름이 깨지지 않도록 과거 메시지부터 순서대로 정렬합니다.						
          },
		  select: { id: true, role: true, content: true, status: true, modelId: true },
        },
      },
    });

    // 만약 데이터베이스에 해당 방 ID가 없다면 404 에러를 반환합니다.
    if (!conversation) {
      return NextResponse.json(
        { error: "존재하지 않는 대화방입니다." },
        { status: 404 }
      );
    }

    // 대화방 정보와 메시지 배열({ id, title, messages: [...] })을 프론트엔드로 응답합니다.
	// 💡 프론트엔드 싱크용 파싱
    return NextResponse.json({
      ...conversation,
	  selectedModels: safeParse(conversation.selectedModels, ["gpt-4o"]),
      disabledPanels: safeParse(conversation.disabledPanels, []),
    });
  } catch (error) {
    console.error("❌ [백엔드] 상세조회 에러:", error);
    return NextResponse.json(
      { error: "대화 내역을 불러오는데 실패했습니다." },
      { status: 500 }
    );
  }
}

// 💡 대화방 정보 수정 (PATCH)
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { conversationId } = await params;
    const body = await req.json();
	const updateData: any = {};

	// 💡 제목 변경 요청이 있을 때
    if (body.title && body.title.trim()) {
      updateData.title = body.title.trim();
    } else {
      return NextResponse.json({ error: "제목이 필요합니다." }, { status: 400 });
    }

	// 💡 모델 변경이나 ON/OFF 변경 요청이 있을 때
	// 💡 업데이트 요청이 오면 다시 문자열로 압축하여 DB에 찌릅니다.
    if (body.selectedModels) updateData.selectedModels = JSON.stringify(body.selectedModels);
    if (body.disabledPanels) updateData.disabledPanels = JSON.stringify(body.disabledPanels);	
	
    // Prisma를 통해 데이터베이스 업데이트 수행
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
    });

	return NextResponse.json({
      ...updatedConversation,
	  selectedModels: safeParse(updatedConversation.selectedModels, ["gpt-4o"]),
      disabledPanels: safeParse(updatedConversation.disabledPanels, []),
    });
  } catch (error) {
	console.error("❌ [백엔드] 수정 API 에러:", error);	  
    return NextResponse.json({ error: "수정 실패" }, { status: 500 });
  }
}

// 💡 대화방 삭제 (DELETE)
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { conversationId } = await params;

    await prisma.conversation.delete({
      where: { id: conversationId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("❌ [백엔드] 삭제 API 에러:", error);
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }
}