import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { conversationKindNotSupportedResponse, isChatConversationKind } from "@/lib/conversationKindGuard";
import { continuationShareRefusal } from "@/lib/continuationSharingPolicy";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { isMemoryInjectionEnabled } from "@/lib/appSettings";
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
import {
  featureNotIncludedResponse,
  getUserBillingPlan,
} from "@/lib/billingEntitlements";
import { getOperationalFeatureFlags } from "@/lib/appSettings";

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

export async function POST(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/share">
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  const params = await context.params;
  const conversationId = params.conversationId;
  const userId = session.user.id;
  if (!(await getOperationalFeatureFlags()).publicSharingEnabled) {
    return NextResponse.json(
      { error: "Public sharing is temporarily disabled for operational maintenance." },
      { status: 503 }
    );
  }
  const billingPlan = await getUserBillingPlan(userId);
  if (!billingPlan.allowSharing) {
    return featureNotIncludedResponse("sharing");
  }
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
      kind: true,
      shareToken: true,
      shareEnabled: true,
      shareRevokedAt: true,
      chatRecoveryEpoch: true,
    },
  });

  if (!accessConversation || accessConversation.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Sharing an image conversation is explicitly out of scope for v1: the
  // share snapshot schema carries text messages only and publishing R2
  // assets needs its own design (docs/policy/image-generation.md §1).
  if (!isChatConversationKind(accessConversation.kind)) {
    return conversationKindNotSupportedResponse();
  }
  // A conversation continued from an imported chat is not publishable in the
  // first release (docs/policy/external-conversation-continuation.md §9). The
  // snapshot carries `Message` rows, so publishing it would publish half a
  // conversation -- answers that refer to an excerpt the reader cannot see --
  // and carrying the other half would publish a third-party transcript the
  // import promised to keep account-private. The refusal names itself so the
  // composer can say why rather than showing a control that fails.
  const shareRefusal = continuationShareRefusal({
    hasContinuationBridge:
      (await prisma.conversationContinuationBridge.count({
        where: { conversationId, userId },
      })) > 0,
  });
  if (shareRefusal) {
    logSecurityAuditEvent("conversation.share.create", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "denied",
      reason: shareRefusal.code,
    });
    return NextResponse.json(
      { error: shareRefusal.message, code: shareRefusal.code },
      { status: shareRefusal.status }
    );
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
    // Recorded now, not read when the page is viewed (§13.3): turning
    // injection off later does not un-influence answers already generated.
    personalizationPossible: await isMemoryInjectionEnabled(),
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

  // Publish only while the ownership, lock and share generation we checked
  // still hold. A concurrent lock, revoke or replacement share wins over this
  // in-flight preparation; no new link is issued for its stale snapshot.
  // Compare both directions of the transcript and refuse a new continuation
  // bridge in the same statement as publication, with no check/write gap.
  const shareToken = createShareToken();
  const updated = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH prepared_messages AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(parsedSnapshot.data.messages)}::jsonb)
        AS message("id" text, "role" text, "content" text, "modelId" text, "createdAt" timestamp(3))
    ), current_messages AS (
      SELECT "id", "role", "content", "modelId", "createdAt"
      FROM "Message"
      WHERE "conversationId" = ${conversationId} AND "role" IN ('user', 'assistant')
    )
    UPDATE "Conversation" AS conversation
    SET "shareToken" = ${shareToken},
        "shareEnabled" = true,
        "sharedAt" = ${sharedAt.toISOString()}::timestamp(3),
        "shareExpiresAt" = ${expiresAt.toISOString()}::timestamp(3),
        "shareRevokedAt" = NULL,
        "shareSnapshot" = ${JSON.stringify(parsedSnapshot.data)}::jsonb,
        "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    WHERE conversation."id" = ${conversationId}
      AND conversation."userId" = ${userId}
      AND conversation."password" IS NOT DISTINCT FROM ${accessConversation.password}::text
      AND conversation."kind" = ${accessConversation.kind}
      AND conversation."shareToken" IS NOT DISTINCT FROM ${accessConversation.shareToken}::text
      AND conversation."shareEnabled" = ${accessConversation.shareEnabled}
      AND conversation."shareRevokedAt" IS NOT DISTINCT FROM ${accessConversation.shareRevokedAt?.toISOString() ?? null}::timestamp(3)
      AND conversation."chatRecoveryEpoch" = ${accessConversation.chatRecoveryEpoch}
      AND NOT EXISTS (
        SELECT 1 FROM "ConversationContinuationBridge" bridge
        WHERE bridge."conversationId" = conversation."id"
      )
      AND NOT EXISTS (
        (SELECT * FROM current_messages EXCEPT SELECT * FROM prepared_messages)
        UNION ALL
        (SELECT * FROM prepared_messages EXCEPT SELECT * FROM current_messages)
      )
    RETURNING conversation."id"
  `);
  if (updated.length !== 1) {
    logSecurityAuditEvent("conversation.share.create", {
      userId,
      resourceId: conversationId,
      request: req,
      outcome: "denied",
      reason: "SHARE_SOURCE_CHANGED",
    });
    return NextResponse.json(
      { error: "The conversation changed while preparing its share. Try again.", code: "SHARE_SOURCE_CHANGED" },
      { status: 409 }
    );
  }

  const baseUrl = getPublicAppOrigin(req);
  logSecurityAuditEvent("conversation.share.create", {
    userId,
    resourceId: conversationId,
    request: req,
    outcome: "success",
  });

  return NextResponse.json({
    url: `${baseUrl}/share/${shareToken}`,
    expiresAt: expiresAt.toISOString(),
  });
}

export async function DELETE(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/share">
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  const params = await context.params;
  const conversationId = params.conversationId;
  const userId = session.user.id;
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
