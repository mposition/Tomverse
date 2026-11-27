export const dynamic = "force-dynamic";
import {
  CHAT_MAX_MESSAGE_BODY_BYTES,
  CHAT_MAX_MESSAGE_CHARACTERS,
} from "@/lib/chatRequestLimits";

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
import { createConversation } from "@/lib/conversationCreation";
import { REVIEW_PRODUCT_KEY } from "@/lib/conversationProduct";

const modelIdSchema = z.string().min(1).max(120);

const importMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(CHAT_MAX_MESSAGE_CHARACTERS),
    // "incomplete" travels with the message like every other status: a guest
    // answer the provider cut short must still read as cut short after the
    // conversation is imported into an account.
    status: z
      .enum(["normal", "incomplete", "error", "cancelled"])
      .optional()
      .default("normal"),
    modelId: modelIdSchema.nullable().optional(),
    createdAt: z.string().datetime(),
    // A turn the guest replaced (regenerate, edit) is imported as it stands in
    // the guest's history, marked replaced, so the account keeps it and the
    // model is not shown it again (Message.supersededAt).
    superseded: z.literal(true).optional(),
  })
  // Every message, question or answer, is held to one limit and stored whole:
  // the guest already has the full answer on screen, and an import that cut it
  // would report success while losing what it was asked to keep (review
  // r-20261118-075201-6d1a48).
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

    const body = await readLimitedJson(req, CHAT_MAX_MESSAGE_BODY_BYTES, importGuestConversationSchema);

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

      const conversation = await createConversation(tx, {
        userId,
        title: body.title,
        // What the guest conversation already was. A guest transcript is a
        // multi-model comparison, so importing it produces a Review
        // conversation; the import changes ownership, not the product.
        productKey: REVIEW_PRODUCT_KEY,
        selectedModels: JSON.stringify(normalizedModels),
        disabledPanels: JSON.stringify(normalizedDisabled),
        importedGuestKey: body.guestConversationId,
        createdAt: new Date(body.createdAt),
        updatedAt: new Date(lastMessageAt),
      });

      await assertMessageCapacity(
        tx,
        userId,
        conversation.id,
        body.messages.length,
        contentBytes
      );

      const importedAt = new Date();
      await tx.message.createMany({
        data: body.messages.map((message) => ({
          conversationId: conversation.id,
          role: message.role,
          content: message.content,
          status: message.status,
          modelId: message.modelId || null,
          createdAt: new Date(message.createdAt),
          ...(message.superseded ? { supersededAt: importedAt } : {}),
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
