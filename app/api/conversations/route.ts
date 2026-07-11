export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
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

export async function GET(req: Request) {
  try {
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

      const userSettings = await prisma.userSettings.findUnique({
          where: { userId }
      });
      const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;

    const conversations = await prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    const formattedConversations = conversations.map((conv) => ({
      id: conv.id,
      title: conv.title,
        selectedModels: safeParse(conv.selectedModels, [defaultEngine]),
        disabledPanels: safeParse(conv.disabledPanels, []),
        isLocked: !!conv.password,
        shareEnabled:
          conv.shareEnabled &&
          !!conv.shareExpiresAt &&
          conv.shareExpiresAt > new Date(),
        shareExpiresAt: conv.shareExpiresAt?.toISOString() || null,
        password: undefined
    }));

      return NextResponse.json(formattedConversations);
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;

    console.error("Failed to list conversations:", error);
    return NextResponse.json(
      { error: "Failed to load conversations." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

      const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "conversation-create", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 8 * 1024, createConversationSchema);
    const title = body.title || "New chat";

      const userSettings = await prisma.userSettings.findUnique({
          where: { userId }
      });
      const defaultEngine = userSettings?.defaultModel || APP_DEFAULTS.defaultModelId;

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
          password: undefined
      };

      return NextResponse.json(formattedConversation);      
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to create conversation:", error);
    return NextResponse.json(
      { error: "Failed to create conversation." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "conversation-delete-all", {
      minute: 2,
      day: 5,
    });

    const result = await prisma.conversation.deleteMany({
      where: { userId },
    });

    return NextResponse.json({ success: true, deleted: result.count });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to delete all conversations:", error);
    return NextResponse.json(
      { error: "Failed to delete conversations." },
      { status: 500 }
    );
  }
}
