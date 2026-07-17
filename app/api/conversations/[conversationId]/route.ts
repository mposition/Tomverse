export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import {
  clampRuntimeSelectedModels,
  isEnabledRuntimeModelId,
} from "@/lib/modelRegistry";
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
import {
    logSecurityAuditEvent,
    type SecurityAuditEvent,
} from "@/lib/securityAudit";
import {
    effectivePlanModelLimit,
    getUserBillingPlan,
    modelLimitResponse,
} from "@/lib/billingEntitlements";

const modelSchema = z.string().min(1).max(120);
const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    password: z.union([z.string().min(8).max(128), z.null()]).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
    selectedModels: z
      .array(modelSchema)
      .max(APP_DEFAULTS.maxSelectedModels)
      .optional(),
    disabledPanels: z
      .array(modelSchema)
      .max(APP_DEFAULTS.maxSelectedModels)
      .optional(),
    projectId: z.union([z.string().trim().min(1).max(100), z.null()]).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.title !== undefined ||
      body.password !== undefined ||
      body.selectedModels !== undefined ||
      body.disabledPanels !== undefined ||
      body.projectId !== undefined,
    { message: "At least one update is required." }
  );
const MESSAGE_PAGE_SIZE = 50;

const safeParse = (data: unknown, fallback: string[]) => {
  if (!data) return fallback;
  let parsed: unknown = data;
  for (let i = 0; i < 2 && typeof parsed === "string"; i++) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return fallback;
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string")
    : fallback;
};

type Params = {
  params: Promise<{
    conversationId: string;
  }>;
};

export async function GET(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]">
) {
    try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "conversation-detail", {
      minute: 300,
      day: 20_000,
    });

    const params = await context.params;
    const conversationId = params.conversationId;

    if (!conversationId) {
        return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
    }

    const existingConv = await prisma.conversation.findUnique({
        where: { id: params.conversationId },
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

    const userSettings = await prisma.userSettings.findUnique({
        where: { userId }
    });
        const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;
	
    const searchParams = new URL(req.url).searchParams;
    const cursor = searchParams.get("cursor");
    const requestedModelId = searchParams.get("modelId");
    if (cursor && (cursor.length > 100 || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
      return NextResponse.json(
        { error: "Invalid message cursor." },
        { status: 400 }
      );
    }
    if (requestedModelId && !(await isEnabledRuntimeModelId(requestedModelId))) {
      return NextResponse.json(
        { error: "Invalid model ID." },
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
        projectId: true,
        shareEnabled: true,
        shareExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        password: true,
      },
    });

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found." },
        { status: 404 }
      );
    }
        if (conversation.userId !== userId) {
        return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
    }

    const messagePage = await prisma.message.findMany({
      where: {
        conversationId,
        ...(requestedModelId
          ? {
              OR: [
                { role: "user", modelId: null },
                { role: "user", modelId: requestedModelId },
                { role: "assistant", modelId: requestedModelId },
              ],
            }
          : {}),
      },
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

    const selectedModels = await clampRuntimeSelectedModels(
      safeParse(conversation.selectedModels, [defaultEngine])
    );
    return NextResponse.json({
      ...conversation,
        messages,
        projectId: conversation.projectId || null,
        messagePage: {
          hasMore: hasMoreMessages,
          nextCursor: hasMoreMessages ? messages.at(-1)?.id || null : null,
        },
        selectedModels,
        disabledPanels: safeParse(conversation.disabledPanels, []).filter(
          (modelId: string) => selectedModels.includes(modelId)
        ),
        isLocked: !!conversation.password,
        shareEnabled:
          conversation.shareEnabled &&
          !!conversation.shareExpiresAt &&
          conversation.shareExpiresAt > new Date(),
        shareExpiresAt: conversation.shareExpiresAt?.toISOString() || null,
        shareToken: undefined,
        shareSnapshot: undefined,
        password: undefined
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("Failed to load conversation details:", error);
    return NextResponse.json(
      { error: "Failed to load conversation." },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        }

        const userId = session.user.id;
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
        const conversationId = params.conversationId;

        if (!conversationId) {
            console.error("Conversation ID is missing in PATCH route params.");
            return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
        }

        const existingConv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, selectedModels: true, password: true }
        });

        if (!existingConv) {
            return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
        }
        if (existingConv.userId !== userId) {
            return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
        }

        const userSettings = await prisma.userSettings.findUnique({
            where: { userId }
        });
        const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;
        const billingPlan = await getUserBillingPlan(userId);
        const maxModels = effectivePlanModelLimit(billingPlan);

	const updateData: Prisma.ConversationUpdateInput = {};
      const { title, password, currentPassword } = body;
      const lockAuditEvent: SecurityAuditEvent | null =
          password === undefined
              ? null
              : password === null
                ? "conversation.lock.remove"
                : existingConv.password
                  ? "conversation.lock.change"
                  : "conversation.lock.set";
      if (lockAuditEvent) {
          logSecurityAuditEvent(lockAuditEvent, {
              userId,
              resourceId: conversationId,
              request: req,
              outcome: "attempt",
          });
      }
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

    if (title !== undefined) {
      updateData.title = title;
      } 

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
                      logSecurityAuditEvent("conversation.lock.remove", {
                          userId,
                          resourceId: conversationId,
                          request: req,
                          outcome: "denied",
                          reason: "INVALID_LOCK_PASSWORD",
                      });
                      return NextResponse.json(
                          {
                              success: false,
                              error: "Invalid password.",
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
                      logSecurityAuditEvent("conversation.lock.change", {
                          userId,
                          resourceId: conversationId,
                          request: req,
                          outcome: "denied",
                          reason: "INVALID_LOCK_PASSWORD",
                      });
                      return NextResponse.json(
                          {
                              success: false,
                              error: "Invalid password.",
                          },
                          { status: 403 }
                      );
                  }
                  await clearLockVerificationAttempts(attempt);
              }
              updateData.password = await hashConversationPassword(password);
          }
      }

    const normalizedModels = await (
      body.selectedModels !== undefined
        ? clampRuntimeSelectedModels(body.selectedModels)
        : clampRuntimeSelectedModels(
            safeParse(existingConv.selectedModels, [defaultEngine])
          ));

    if (
      body.selectedModels !== undefined &&
      normalizedModels.length !== new Set(body.selectedModels).size
    ) {
      return NextResponse.json(
        { error: "One or more selected models are unavailable." },
        { status: 400 }
      );
    }

    if (body.selectedModels !== undefined && normalizedModels.length > maxModels) {
      return modelLimitResponse(maxModels);
    }

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

    if (body.projectId !== undefined) {
      if (body.projectId === null) {
        updateData.project = { disconnect: true };
      } else {
        const project = await prisma.conversationProject.findFirst({
          where: { id: body.projectId, userId },
          select: { id: true },
        });
        if (!project) {
          return NextResponse.json(
            { error: "Project not found." },
            { status: 404 }
          );
        }
        updateData.project = { connect: { id: project.id } };
      }
    }
	
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ success: true, message: "No changes." });
    }	
	
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
    });
    if (lockAuditEvent) {
      logSecurityAuditEvent(lockAuditEvent, {
        userId,
        resourceId: conversationId,
        request: req,
        outcome: "success",
      });
    }

    const responseSelectedModels = await clampRuntimeSelectedModels(
      safeParse(updatedConversation.selectedModels, [defaultEngine])
    );
	const response = NextResponse.json({
      ...updatedConversation,
        projectId: updatedConversation.projectId || null,
        selectedModels: responseSelectedModels,
      disabledPanels: safeParse(updatedConversation.disabledPanels, []).filter(
        (modelId: string) => responseSelectedModels.includes(modelId)
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
        password: undefined
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

	console.error("Failed to update conversation:", error);	  
    return NextResponse.json({ error: "Failed to update conversation." }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        }

    const { conversationId } = await params;
      const userId = session.user.id;
      await consumeApiRateLimit(req, userId, "conversation-delete", {
        minute: 10,
        day: 100,
      });

      const existingConv = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { userId: true, password: true }
      });

      if (!existingConv) {
          return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (existingConv.userId !== userId) {
          return NextResponse.json({ error: "You do not have access to this conversation." }, { status: 403 });
      }
    logSecurityAuditEvent("conversation.delete", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "attempt",
    });

    if (
      !hasConversationUnlockGrant(
        req,
        userId,
        conversationId,
        existingConv.password
      )
    ) {
      logSecurityAuditEvent("conversation.delete", {
        userId,
        resourceId: conversationId,
        request: req,
        outcome: "denied",
        reason: "CONVERSATION_LOCKED",
      });
      return conversationLockedResponse();
    }

    await prisma.conversation.delete({
      where: { id: conversationId },
    });
    logSecurityAuditEvent("conversation.delete", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "success",
    });

    const response = NextResponse.json({ success: true });
    response.headers.append(
      "Set-Cookie",
      clearConversationUnlockCookie(conversationId)
    );
    return response;
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("Failed to delete conversation:", error);
    return NextResponse.json({ error: "Failed to delete conversation." }, { status: 500 });
  }
}
