export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next"; // 💡 1. 세션 조회를 위한 임포트 추가
import { authOptions } from "@/lib/auth"; // 💡 2. NextAuth 설정 옵션 임포트
import { APP_DEFAULTS, clampSelectedModels } from "@/lib/appDefaults";
import { isEnabledModelId } from "@/lib/models";
import { z } from "zod";
import {
  apiSecurityResponse,
  assertConversationCapacity,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const modelSchema = z.string().max(100).refine(isEnabledModelId);
const createConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    selectedModels: z.array(modelSchema).max(APP_DEFAULTS.maxSelectedModels).optional(),
    disabledPanels: z.array(modelSchema).max(APP_DEFAULTS.maxSelectedModels).optional(),
  })
  .strict();

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
export async function GET(req: Request) {
  try {
    // 현재 로그인한 실제 유저 세션을 가져옵니다.
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) {
      return NextResponse.json(
        { error: "Login required" },
        { status: 401 }
      );
    }
    await consumeApiRateLimit(req, userId, "conversation-list", {
      minute: 60,
      day: 5_000,
    });

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
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

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
    await consumeApiRateLimit(req, userId, "conversation-create", {
      minute: 10,
      day: 100,
    });
    // 요청 바디 데이터 파싱 (page.tsx에서 전송하는 구조와 일치)
    const body = await readLimitedJson(req, 8 * 1024, createConversationSchema);
    const title = body.title || "새 대화";

      const userSettings = await prisma.userSettings.findUnique({
          where: { userId }
      });
      const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;

	// 💡 프론트엔드에서 넘겨준 모델 세팅값을 받아옵니다 (없으면 기본값)
	// 💡 배열 데이터를 DB 저장을 위해 JSON 문자열로 변환합니다.
    const normalizedModels = clampSelectedModels(
      body.selectedModels || [defaultEngine]
    );
    const activeModels =
      normalizedModels.length > 0 ? normalizedModels : [defaultEngine];
    const normalizedDisabled = Array.from(
      new Set(body.disabledPanels || [])
    ).filter((modelId) => activeModels.includes(modelId));
    const selectedModels = JSON.stringify(activeModels);
    const disabledPanels = JSON.stringify(normalizedDisabled);

    // Prisma를 사용하여 DB에 새로운 대화방 레코드 생성
    const newConversation = await prisma.$transaction(async (tx) => {
      await assertConversationCapacity(tx, userId);
      return tx.conversation.create({
        data: {
          userId,
          title,
          selectedModels,
          disabledPanels,
        },
      });
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
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("❌ [백엔드] 대화방 생성 에러:", error);
    return NextResponse.json(
      { error: "대화방 생성 실패" },
      { status: 500 }
    );
  }
}
