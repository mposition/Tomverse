export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next"; // 💡 세션 조회를 위한 임포트 추가
import { authOptions } from "@/lib/auth"; // 💡 NextAuth 설정 옵션 임포트
import { APP_DEFAULTS, clampSelectedModels } from "@/lib/appDefaults";
import { isEnabledModelId } from "@/lib/models";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    clearConversationUnlockCookie,
    clearLockVerificationAttempts,
    conversationLockedResponse,
    consumeLockVerificationAttempt,
    hasConversationUnlockGrant,
    hashConversationPassword,
    lockErrorResponse,
    verifyConversationPassword,
} from "@/lib/conversationLock";

const modelSchema = z.string().max(100).refine(isEnabledModelId);
const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    password: z.union([z.string().min(4).max(128), z.null()]).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
    selectedModels: z
      .array(modelSchema)
      .max(APP_DEFAULTS.maxSelectedModels)
      .optional(),
    disabledPanels: z
      .array(modelSchema)
      .max(APP_DEFAULTS.maxSelectedModels)
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.title !== undefined ||
      body.password !== undefined ||
      body.selectedModels !== undefined ||
      body.disabledPanels !== undefined,
    { message: "At least one update is required." }
  );
const MESSAGE_PAGE_SIZE = 50;

// 💡 방어 함수 추가
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

type Params = {
  params: Promise<{
    conversationId: string;
  }>;
};

// 💡 특정 대화방의 상세 정보와 그 방에 쌓인 모든 메시지를 가져오는 GET 메서드
export async function GET(req: Request, context: any) {
    try {
    // 현재 로그인한 사용자의 세션을 확인합니다.
    const session = await getServerSession(authOptions);
    if (!session || !session.user || !(session.user as any).id) {
        return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    }
    const userId = (session.user as any).id;

    // params 추출 (Next 15의 비동기 params 대응)
    const params = await context.params;
    const conversationId = params.conversationId || params.id;

    if (!conversationId) {
        return NextResponse.json({ error: "대화방 ID가 누락되었습니다." }, { status: 400 });
    }

    const existingConv = await prisma.conversation.findUnique({
        where: { id: params.conversationId },
        select: { userId: true, password: true }
    });

    if (!existingConv || existingConv.userId !== userId) {
        return NextResponse.json({ error: "접근 권한이 없습니다." }, { status: 403 });
    }

    // 사용자의 설정 정보(UserSettings)를 조회하여 설정된 기본 AI 엔진 모델을 확보합니다.
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

    const userSettings = await prisma.userSettings.findUnique({
        where: { userId }
    });
        const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;
	
    const cursor = new URL(req.url).searchParams.get("cursor");
    if (cursor && (cursor.length > 100 || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
      return NextResponse.json(
        { error: "Invalid message cursor." },
        { status: 400 }
      );
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        userId: true,
        title: true,
        selectedModels: true,
        disabledPanels: true,
        shareEnabled: true,
        shareExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        password: true,
      },
    });

    // 만약 데이터베이스에 해당 방 ID가 없다면 404 에러를 반환합니다.
    if (!conversation) {
      return NextResponse.json(
        { error: "존재하지 않는 대화방입니다." },
        { status: 404 }
      );
    }
        if (conversation.userId !== userId) {
        return NextResponse.json({ error: "접근 권한이 없는 타인의 대화방입니다." }, { status: 403 });
    }

    const messagePage = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MESSAGE_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        role: true,
        content: true,
        status: true,
        modelId: true,
      },
    });
    const hasMoreMessages = messagePage.length > MESSAGE_PAGE_SIZE;
    const messages = hasMoreMessages
      ? messagePage.slice(0, MESSAGE_PAGE_SIZE)
      : messagePage;

    // 대화방 정보와 제한된 메시지 페이지를 프론트엔드로 응답합니다.
	// 💡 프론트엔드 싱크용 파싱
    return NextResponse.json({
      ...conversation,
        messages,
        messagePage: {
          hasMore: hasMoreMessages,
          nextCursor: hasMoreMessages ? messages.at(-1)?.id || null : null,
        },
        selectedModels: clampSelectedModels(
          safeParse(conversation.selectedModels, [defaultEngine])
        ),
        disabledPanels: safeParse(conversation.disabledPanels, []).filter(
          (modelId: string) =>
            clampSelectedModels(
              safeParse(conversation.selectedModels, [defaultEngine])
            ).includes(modelId)
        ),
        isLocked: !!conversation.password,
        shareEnabled:
          conversation.shareEnabled &&
          !!conversation.shareExpiresAt &&
          conversation.shareExpiresAt > new Date(),
        shareExpiresAt: conversation.shareExpiresAt?.toISOString() || null,
        shareToken: undefined,
        shareSnapshot: undefined,
        password: undefined // 원본 암호는 절대 흘리지 않음
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
export async function PATCH(req: Request, context: any) {
    try {
        const session = await getServerSession(authOptions);
        if (!session || !session.user || !(session.user as any).id) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }

        // 바디 파싱 에러 방어
        const userId = (session.user as any).id;
        await consumeApiRateLimit(req, userId, "conversation-update", {
            minute: 30,
            day: 1000,
        });
        const body = await readLimitedJson(
            req,
            16 * 1024,
            updateConversationSchema
        );
        const params = await context.params;
        const conversationId = params.conversationId || params.id; // 폴더명이 [id]일 경우도 방어

        if (!conversationId) {
            console.error("❌ [백엔드 PATCH] 대화방 ID를 찾을 수 없습니다. (폴더명을 확인하세요)");
            return NextResponse.json({ error: "대화방 ID 누락" }, { status: 400 });
        }

        // 실제 DB 통신 전, 대화방 소유권 선행 검증!
        const existingConv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, selectedModels: true, password: true }
        });

        if (!existingConv) {
            return NextResponse.json({ error: "존재하지 않는 대화방입니다." }, { status: 404 });
        }
        if (existingConv.userId !== userId) {
            return NextResponse.json({ error: "접근 권한이 없는 타인의 대화방입니다." }, { status: 403 });
        }

        // 사용자의 기본 설정을 미리 조회합니다.
        const userSettings = await prisma.userSettings.findUnique({
            where: { userId }
        });
        const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;

	const updateData: any = {};
      const { title, password, currentPassword } = body;
      if (
          existingConv.password &&
          password === undefined &&
          !hasConversationUnlockGrant(
              req,
              userId,
              conversationId,
              existingConv.password
          )
      ) {
          return conversationLockedResponse();
      }

	// 💡 제목 변경 요청이 있을 때
    if (title !== undefined) {
      updateData.title = title;
      } 

      // 💡 잠금 설정
      if (password !== undefined) {
          if (password === null) {
              if (existingConv.password) {
                  const attempt = await consumeLockVerificationAttempt(
                      req,
                      userId,
                      conversationId
                  );
                  const verification = await verifyConversationPassword(
                      currentPassword,
                      existingConv.password
                  );
                  if (!verification.matches) {
                      return NextResponse.json(
                          {
                              success: false,
                              error: "비밀번호가 일치하지 않습니다.",
                          },
                          { status: 403 }
                      );
                  }
                  await clearLockVerificationAttempts(attempt);
              }
              updateData.password = null;
          } else {
              if (existingConv.password) {
                  const attempt = await consumeLockVerificationAttempt(
                      req,
                      userId,
                      conversationId
                  );
                  const verification = await verifyConversationPassword(
                      currentPassword,
                      existingConv.password
                  );
                  if (!verification.matches) {
                      return NextResponse.json(
                          {
                              success: false,
                              error: "비밀번호가 일치하지 않습니다.",
                          },
                          { status: 403 }
                      );
                  }
                  await clearLockVerificationAttempts(attempt);
              }
              updateData.password = await hashConversationPassword(password);
          }
      }

      // 💡 잠금 해제
	// 💡 모델 변경이나 ON/OFF 변경 요청이 있을 때
	// 💡 업데이트 요청이 오면 다시 문자열로 압축하여 DB에 찌릅니다.
    const normalizedModels =
      body.selectedModels !== undefined
        ? clampSelectedModels(body.selectedModels)
        : clampSelectedModels(
            safeParse(existingConv.selectedModels, [defaultEngine])
          );

	if (body.selectedModels !== undefined) {
      updateData.selectedModels = JSON.stringify(
        normalizedModels.length > 0 ? normalizedModels : [defaultEngine]
      );
    }
    if (body.disabledPanels !== undefined) {
      const activeModels =
        normalizedModels.length > 0 ? normalizedModels : [defaultEngine];
      const disabledPanels = Array.from(
        new Set(
          body.disabledPanels.filter((modelId) =>
            activeModels.includes(modelId)
          )
        )
      );
      updateData.disabledPanels = JSON.stringify(disabledPanels);
    }	
	
	// 만약 업데이트할 데이터가 없다면 그냥 기존 데이터 반환
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ success: true, message: "변경사항 없음" });
    }	
	
    // Prisma를 통해 데이터베이스 업데이트 수행
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
    });

	const response = NextResponse.json({
      ...updatedConversation,
        selectedModels: clampSelectedModels(
          safeParse(updatedConversation.selectedModels, [defaultEngine])
        ),
      disabledPanels: safeParse(updatedConversation.disabledPanels, []).filter(
        (modelId: string) =>
          clampSelectedModels(
            safeParse(updatedConversation.selectedModels, [defaultEngine])
          ).includes(modelId)
      ),
        isLocked: !!updatedConversation.password,
        shareEnabled:
          updatedConversation.shareEnabled &&
          !!updatedConversation.shareExpiresAt &&
          updatedConversation.shareExpiresAt > new Date(),
        shareExpiresAt:
          updatedConversation.shareExpiresAt?.toISOString() || null,
        shareToken: undefined,
        shareSnapshot: undefined,
        password: undefined // 원본 암호는 절대 흘리지 않음
    });
    if (password !== undefined) {
      response.headers.append(
        "Set-Cookie",
        clearConversationUnlockCookie(conversationId)
      );
    }
    return response;
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    const lockError = lockErrorResponse(error);
    if (lockError) return lockError;

	console.error("❌ [백엔드] 수정 API 에러:", error);	  
    return NextResponse.json({ error: "수정 실패" }, { status: 500 });
  }
}

// 💡 대화방 삭제 (DELETE)
export async function DELETE(req: Request, { params }: Params) {
    try {
        const session = await getServerSession(authOptions);
        if (!session || !session.user || !(session.user as any).id) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }

    const { conversationId } = await params;
      const userId = (session.user as any).id;

      // 실제 DB 통신 전, 대화방 소유권 선행 검증!
      const existingConv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, password: true }
      });

      if (!existingConv) {
          return NextResponse.json({ error: "존재하지 않는 대화방입니다." }, { status: 404 });
      }
      if (existingConv.userId !== userId) {
          return NextResponse.json({ error: "접근 권한이 없는 타인의 대화방입니다." }, { status: 403 });
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

    await prisma.conversation.delete({
      where: { id: conversationId },
    });

    const response = NextResponse.json({ success: true });
    response.headers.append(
      "Set-Cookie",
      clearConversationUnlockCookie(conversationId)
    );
    return response;
  } catch (error) {
    console.error("❌ [백엔드] 삭제 API 에러:", error);
    return NextResponse.json({ error: "삭제 실패" }, { status: 500 });
  }
}
