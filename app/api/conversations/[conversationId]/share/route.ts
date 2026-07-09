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
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

const getShareTtlDays = () => {
  const configured = Number(process.env.SHARE_LINK_TTL_DAYS);
  return Number.isInteger(configured) && configured >= 1 && configured <= 365
    ? configured
    : 30;
};
const SHARE_MESSAGE_PAGE_SIZE = 50;

const applyShareRateLimit = async (
  req: Request,
  userId: string,
  scope: "conversation-share-create" | "conversation-share-revoke",
  limits: { minute: number; day: number }
) => {
  try {
    await consumeApiRateLimit(req, userId, scope, limits);
    return null;
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    throw error;
  }
};

export async function POST(req: Request, context: any) {
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as any).id) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  const params = await context.params;
  const conversationId = params.conversationId;
  const userId = (session.user as any).id;
  const rateLimitResponse = await applyShareRateLimit(
    req,
    userId,
    "conversation-share-create",
    { minute: 10, day: 100 }
  );
  if (rateLimitResponse) {
    logSecurityAuditEvent("conversation.share.create", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "rate_limited",
    });
    return rateLimitResponse;
  }

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
  logSecurityAuditEvent("conversation.share.create", {
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
      accessConversation.password
    )
  ) {
    logSecurityAuditEvent("conversation.share.create", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "denied",
      reason: "CONVERSATION_LOCKED",
    });
    return conversationLockedResponse();
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      title: true,
      createdAt: true,
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
    messages: [],
  };
  let snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  let messageCursor: string | undefined;

  while (true) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: { in: ["user", "assistant"] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: SHARE_MESSAGE_PAGE_SIZE,
      ...(messageCursor
        ? { cursor: { id: messageCursor }, skip: 1 }
        : {}),
      select: {
        id: true,
        role: true,
        content: true,
        modelId: true,
        createdAt: true,
      },
    });

    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const snapshotMessage: ShareSnapshot["messages"][number] = {
        id: message.id,
        role: message.role,
        content: message.content,
        modelId: message.modelId,
        createdAt: message.createdAt.toISOString(),
      };
      const separatorBytes = snapshot.messages.length > 0 ? 1 : 0;
      const messageBytes =
        Buffer.byteLength(JSON.stringify(snapshotMessage), "utf8") +
        separatorBytes;
      if (
        snapshot.messages.length >= 10_000 ||
        snapshotBytes + messageBytes > MAX_SHARE_SNAPSHOT_BYTES
      ) {
        return NextResponse.json(
          {
            error: "Conversation is too large to share.",
            code: "SHARE_TOO_LARGE",
          },
          { status: 413 }
        );
      }
      snapshot.messages.push(snapshotMessage);
      snapshotBytes += messageBytes;
    }

    if (messages.length < SHARE_MESSAGE_PAGE_SIZE) break;
    messageCursor = messages.at(-1)?.id;
    if (!messageCursor) break;
  }

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
  logSecurityAuditEvent("conversation.share.create", {
    userId,
    resourceId: conversationId,
    request: req,
    outcome: "success",
  });

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
  const rateLimitResponse = await applyShareRateLimit(
    req,
    userId,
    "conversation-share-revoke",
    { minute: 20, day: 200 }
  );
  if (rateLimitResponse) {
    logSecurityAuditEvent("conversation.share.revoke", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "rate_limited",
    });
    return rateLimitResponse;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, password: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  logSecurityAuditEvent("conversation.share.revoke", {
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
      conversation.password
    )
  ) {
    logSecurityAuditEvent("conversation.share.revoke", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "denied",
      reason: "CONVERSATION_LOCKED",
    });
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
  logSecurityAuditEvent("conversation.share.revoke", {
    userId,
    resourceId: conversationId,
    request: req,
    outcome: "success",
  });

  return NextResponse.json({ success: true });
}
