import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { createShareToken } from "@/lib/shareTokens";
import {
  MAX_SHARE_SNAPSHOT_BYTES,
  SHARE_SNAPSHOT_VERSION,
  shareSnapshotSchema,
  type ShareSnapshot,
} from "@/lib/shareSnapshot";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";

const getShareTtlDays = () => {
  const configured = Number(process.env.SHARE_LINK_TTL_DAYS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 365
    ? configured
    : 30;
};

export async function POST(req: Request, context: any) {
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as any).id) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  const params = await context.params;
  const conversationId = params.conversationId;
  const userId = (session.user as any).id;

  const accessConversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      userId: true,
      password: true,
    },
  });

  if (!accessConversation || accessConversation.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (
    !hasConversationUnlockGrant(
      req,
      userId,
      conversationId,
      accessConversation.password
    )
  ) {
    return conversationLockedResponse();
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      title: true,
      createdAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          modelId: true,
          createdAt: true,
        },
      },
    },
  });

  if (!conversation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sharedAt = new Date();
  const expiresAt = new Date(
    sharedAt.getTime() + getShareTtlDays() * 24 * 60 * 60 * 1000
  );
  const snapshot: ShareSnapshot = {
    version: SHARE_SNAPSHOT_VERSION,
    title: conversation.title,
    conversationCreatedAt: conversation.createdAt.toISOString(),
    sharedAt: sharedAt.toISOString(),
    messages: conversation.messages
      .filter(
        (
          message
        ): message is typeof message & { role: "user" | "assistant" } =>
          message.role === "user" || message.role === "assistant"
      )
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        modelId: message.modelId,
        createdAt: message.createdAt.toISOString(),
      })),
  };
  const parsedSnapshot = shareSnapshotSchema.safeParse(snapshot);
  if (
    !parsedSnapshot.success ||
    Buffer.byteLength(JSON.stringify(parsedSnapshot.data), "utf8") >
      MAX_SHARE_SNAPSHOT_BYTES
  ) {
    return NextResponse.json(
      { error: "Conversation is too large to share.", code: "SHARE_TOO_LARGE" },
      { status: 413 }
    );
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      shareToken: createShareToken(),
      shareEnabled: true,
      sharedAt,
      shareExpiresAt: expiresAt,
      shareRevokedAt: null,
      shareSnapshot: parsedSnapshot.data,
    },
    select: { shareToken: true, shareExpiresAt: true },
  });

  const baseUrl = getPublicAppOrigin(req);

  return NextResponse.json({
    url: `${baseUrl}/share/${updated.shareToken}`,
    expiresAt: updated.shareExpiresAt?.toISOString(),
  });
}

export async function DELETE(req: Request, context: any) {
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as any).id) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  const params = await context.params;
  const conversationId = params.conversationId;
  const userId = (session.user as any).id;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, password: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    !hasConversationUnlockGrant(
      req,
      userId,
      conversationId,
      conversation.password
    )
  ) {
    return conversationLockedResponse();
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      shareEnabled: false,
      shareToken: null,
      shareSnapshot: Prisma.DbNull,
      shareExpiresAt: null,
      shareRevokedAt: new Date(),
    },
  });

  return NextResponse.json({ success: true });
}
