export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next"; // 💡 1. 세션 조회를 위한 임포트 추가
import { authOptions } from "@/lib/auth"; // 💡 2. NextAuth 설정 옵션 임포트
import { APP_DEFAULTS } from "@/lib/appDefaults";

// 💡 파싱 에러를 완벽하게 막아주는 방어 함수
const safeParse = (data: any, fallback: any) => {
  if (!data) return fallback;
  let parsed = data;
  for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  return Array.isArray(parsed) ? parsed : fallback;
};

// 💡 대화방 목록을 최신순으로 불러옵니다.
export async function GET() {
  try {
    // 현재 로그인한 실제 유저 세션을 가져옵니다.
    const session = await getServerSession(authOptions);

    // 💡 로그인된 유저의 고유 DB ID 추출, 세션이 없으면 'guest'로 취급하여 통과시켜 줍니다.
    const userId = session?.user ? (session.user as any).id : "guest";

      // 사용자의 설정 정보(UserSettings)를 조회하여 설정된 기본 AI 엔진 모델을 가져옵니다.
      const userSettings = await prisma.userSettings.findUnique({
          where: { userId }
      });
      const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;

    const conversations = await prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" }, // 최근 업데이트된 대화가 위로 오도록 정렬
    });

	// 프론트엔드가 기존 배열 구조로 인식할 수 있게 문자열을 다시 배열로 파싱합니다.
    const formattedConversations = conversations.map((conv) => ({
      id: conv.id,
      title: conv.title,
        selectedModels: safeParse(conv.selectedModels, [defaultEngine]),
        disabledPanels: safeParse(conv.disabledPanels, []),
        isLocked: !!conv.password, // 💡 비밀번호가 존재하면 true
        shareEnabled:
          conv.shareEnabled &&
          !!conv.shareExpiresAt &&
          conv.shareExpiresAt > new Date(),
        shareExpiresAt: conv.shareExpiresAt?.toISOString() || null,
        password: undefined // 프론트로는 비밀번호를 절대 보내지 않음
    }));

      return NextResponse.json(formattedConversations);
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
    // 세션 식별 및 유저 인증 확인
    const session = await getServerSession(authOptions);
    if (!session || !session.user || !(session.user as any).id) {
      return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }

      const userId = (session.user as any).id; // 💡 로그인된 유저의 고유 DB ID 추출
    // 요청 바디 데이터 파싱 (page.tsx에서 전송하는 구조와 일치)
    const body = await req.json();
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "새 대화";

      const userSettings = await prisma.userSettings.findUnique({
          where: { userId }
      });
      const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;

	// 💡 프론트엔드에서 넘겨준 모델 세팅값을 받아옵니다 (없으면 기본값)
	// 💡 배열 데이터를 DB 저장을 위해 JSON 문자열로 변환합니다.
    const selectedModels = Array.isArray(body?.selectedModels) 
      ? JSON.stringify(body.selectedModels) 
        : JSON.stringify([defaultEngine]);
      
    const disabledPanels = Array.isArray(body?.disabledPanels) 
      ? JSON.stringify(body.disabledPanels) 
      : JSON.stringify([]);

    // Prisma를 사용하여 DB에 새로운 대화방 레코드 생성
    const newConversation = await prisma.conversation.create({
      data: {
        userId: (session.user as any).id,
        title: title || "새 대화",
        selectedModels,
        disabledPanels,
      },
    });

      const formattedConversation = {
          ...newConversation,
          selectedModels: safeParse(newConversation.selectedModels, [defaultEngine]),
          disabledPanels: safeParse(newConversation.disabledPanels, []),
          isLocked: !!newConversation.password,
          password: undefined // 원본 암호는 절대 흘리지 않음
      };

	  // 💡 프론트엔드에게 응답할 때는 다시 깔끔한 배열로 변환해서 리턴합니다.
      return NextResponse.json(formattedConversation);      
  } catch (error) {
    console.error("❌ [백엔드] 대화방 생성 에러:", error);
    return NextResponse.json(
      { error: "대화방 생성 실패" },
      { status: 500 }
    );
  }
}
