export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// 💡 파싱 에러를 완벽하게 막아주는 방어 함수
const safeParse = (data: any, fallback: any) => {
  if (!data) return fallback;
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    return fallback;
  }
};

// 💡 대화방 목록을 최신순으로 불러옵니다.
export async function GET() {
  try {
    // MVP를 위해 임시로 하드코딩된 유저 ID를 사용합니다.
    const userId = "demo-user";

    const conversations = await prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" }, // 최근 업데이트된 대화가 위로 오도록 정렬
	  select: {
        id: true,
        title: true,
      },
    });

	// 💡 프론트엔드가 기존 배열 구조로 인식할 수 있게 문자열을 다시 배열로 파싱합니다.
    // const formatted = conversations.map((c) => ({
      // ...c,
      // selectedModels: safeParse(c.selectedModels, ["gpt-4o"]),
      // disabledPanels: safeParse(c.disabledPanels, []),
    // }));

    return NextResponse.json(conversations);
  } catch (error) {
    console.error("❌ [백엔드] 목록 조회 에러:", error);
    return NextResponse.json(
      { error: "대화방 목록을 불러오는데 실패했습니다." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "새 대화";

    const userId = "demo-user";

	// 💡 프론트엔드에서 넘겨준 모델 세팅값을 받아옵니다 (없으면 기본값)
	// 💡 배열 데이터를 DB 저장을 위해 JSON 문자열로 변환합니다.
    const selectedModels = Array.isArray(body?.selectedModels) 
      ? JSON.stringify(body.selectedModels) 
      : JSON.stringify(["gpt-4o"]);
      
    const disabledPanels = Array.isArray(body?.disabledPanels) 
      ? JSON.stringify(body.disabledPanels) 
      : JSON.stringify([]);
	
    const conversation = await prisma.conversation.create({
	  data: {
        userId,
        title,
        selectedModels,
        disabledPanels,
      },
    });

	// 💡 프론트엔드에게 응답할 때는 다시 깔끔한 배열로 변환해서 리턴합니다.
    return NextResponse.json(conversation);
  } catch (error) {
    console.error("❌ [백엔드] 대화방 생성 에러:", error);
    return Nexesponse.json(
      { error: "대화방 생성 실패" },
      { status: 500 }
    );
  }
}