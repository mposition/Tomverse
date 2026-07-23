export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { z } from "zod";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { clampRuntimeSelectedModels, isEnabledRuntimeModelId } from "@/lib/modelRegistry";
import {
  apiSecurityResponse,
  assertConversationCapacity,
  assertMessageCapacity,
  consumeApiRateLimit,
  readLimitedJson,
  STORAGE_LIMITS,
} from "@/lib/apiSecurity";
import {
  effectivePlanModelLimit,
  getUserBillingPlan,
  modelLimitResponse,
} from "@/lib/billingEntitlements";

const modelIdSchema = z.string().min(1).max(120);

const importMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(50_000),
    status: z.enum(["normal", "error", "cancelled"]).optional().default("normal"),
    modelId: modelIdSchema.nullable().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

const importGuestConversationSchema = z
  .object({
    guestConversationId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    title: z.string().trim().min(1).max(120),
    selectedModels: z.array(modelIdSchema).min(1).max(APP_DEFAULTS.maxSelectedModels),
    disabledPanels: z.array(modelIdSchema).max(APP_DEFAULTS.maxSelectedModels).optional(),
    createdAt: z.string().datetime(),
    messages: z
      .array(importMessageSchema)
      .min(1)
      .max(STORAGE_LIMITS.messagesPerConversation()),
  })
  .strict();

// This route only ever copies already-generated guest text into new
// Conversation/Message rows -- it never calls /api/chat, never touches
// ChatUsageBucket (guest quota) or ChatCreditReservation (credits), so
// importing can't double-charge or double-decrement usage by construction.
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;

    await consumeApiRateLimit(req, userId, "conversation-import-guest", {
      minute: 5,
      day: 50,
    });

    const body = await readLimitedJson(req, 2 * 1024 * 1024, importGuestConversationSchema);

    const requestedModelIds = Array.from(
      new Set([
        ...body.selectedModels,
        ...body.messages.flatMap((message) => (message.modelId ? [message.modelId] : [])),
      ])
    );
    const validModelFlags = await Promise.all(requestedModelIds.map(isEnabledRuntimeModelId));
    if (validModelFlags.some((valid) => !valid)) {
      return NextResponse.json({ error: "Unsupported model." }, { status: 400 });
    }

    const billingPlan = await getUserBillingPlan(userId);
    const maxModels = effectivePlanModelLimit(billingPlan);
    const normalizedModels = await clampRuntimeSelectedModels(body.selectedModels, maxModels);
    if (normalizedModels.length === 0) {
      return modelLimitResponse(maxModels);
    }
    const normalizedDisabled = Array.from(new Set(body.disabledPanels || [])).filter(
      (modelId) => normalizedModels.includes(modelId)
    );

    const contentBytes = body.messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, "utf8"),
      0
    );
    const lastMessageAt = body.messages.reduce(
      (max, message) => (message.createdAt > max ? message.createdAt : max),
      body.createdAt
    );

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.conversation.findFirst({
        where: { userId, importedGuestKey: body.guestConversationId },
        select: { id: true },
      });
      if (existing) {
        return { conversationId: existing.id, alreadyImported: true };
      }

      await assertConversationCapacity(tx, userId);

      const conversation = await tx.conversation.create({
        data: {
          userId,
          title: body.title,
          selectedModels: JSON.stringify(normalizedModels),
          disabledPanels: JSON.stringify(normalizedDisabled),
          importedGuestKey: body.guestConversationId,
          createdAt: new Date(body.createdAt),
          updatedAt: new Date(lastMessageAt),
        },
      });

      await assertMessageCapacity(
        tx,
        userId,
        conversation.id,
        body.messages.length,
        contentBytes
      );

      await tx.message.createMany({
        data: body.messages.map((message) => ({
          conversationId: conversation.id,
          role: message.role,
          content: message.content,
          status: message.status,
          modelId: message.modelId || null,
          createdAt: new Date(message.createdAt),
        })),
      });

      return { conversationId: conversation.id, alreadyImported: false };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to import guest conversation:", error);
    return NextResponse.json({ error: "Failed to import conversation." }, { status: 500 });
  }
}
