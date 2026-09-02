export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { enqueueImageAssetCleanupForConversations } from "@/lib/imageAssetLifecycle";
import { enqueueArtifactCleanupForConversations } from "@/lib/generatedArtifactStorage";
import { enqueueMessageAttachmentCleanupForConversations } from "@/lib/messageAttachmentStorage";
import { deleteDeepResearchJobsForConversations } from "@/lib/deepResearchJobs";
import { conversationSurface } from "@/lib/continuationRoutes";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS, normalizeWebSearchMode } from "@/lib/appDefaults";
import {
  clampSelectedModelsAgainstRuntime,
  getRuntimeModels,
} from "@/lib/modelRegistry";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { createConversationForProduct } from "@/lib/conversationCreateHandler";
import { REVIEW_PRODUCT_KEY } from "@/lib/conversationProduct";


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

    // Named columns, not `include`. This route returns the whole conversation
    // list, so `include` fetched every column of every conversation the account
    // has ever had -- including `shareSnapshot`, which is a full serialised
    // copy of a shared conversation and is allowed to reach 5 MB
    // (MAX_SHARE_SNAPSHOT_BYTES), and `password`, the lock hash. Neither is
    // returned: the snapshot was dropped on the floor and the hash was blanked
    // at the response layer with `password: undefined`, one line away from
    // being emitted by a later edit.
    //
    // Withholding a column is a property of the query, not of the mapping over
    // its result. That is also what keeps the memory bounded: an account with a
    // hundred shared conversations pulled hundreds of megabytes into the
    // process to answer a request that sends back a title and a count.
    const conversations = await prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        kind: true,
        projectId: true,
        selectedModels: true,
        disabledPanels: true,
        webSearchMode: true,
        shareEnabled: true,
        shareExpiresAt: true,
        // Read to derive `isLocked`, never emitted. Selecting it is the point
        // at which that decision is visible.
        password: true,
        // Whether this row opens at its own surface rather than in the
        // workspace (docs/policy/external-conversation-continuation.md §8.2).
        // Selected as a relation existence check, not a join of the bridge's
        // columns: the list needs the answer, and none of the provenance.
        continuationBridge: {
          select: {
            id: true,
            /*
              The imported conversation's own name, for a row nobody has
              named yet (lib/continuationDisplayTitle.ts).

              Read here rather than copied onto the row at creation:
              docs/policy/external-conversation-continuation.md §3 keeps the
              source's words out of tables its deletion does not reach,
              and deleting a snapshot deliberately leaves the continuation
              standing. Nulled by the foreign key when the source goes, so the
              name goes with it.

              `password` decides whether the name may be shown at all: a
              locked snapshot withholds its transcript, and its title is part
              of that transcript. Selected, never emitted -- exactly as this
              query already treats the conversation's own password.
            */
            externalConversation: {
              select: { title: true, password: true },
            },
          },
        },
        _count: { select: { messages: true } },
      },
    });

    const runtimeModels = await getRuntimeModels();
    // EXISTING conversations that lost or never had a readable selectedModels
    // value fall back to the single representative model, deliberately NOT to
    // the account's new-conversation combination: applying the combination
    // here would silently widen an old single-model conversation into several
    // panels. The combination only ever shapes a NEW conversation (see the
    // POST handler below and docs/policy/default-model-luna-migration.md
    // §1.2).
    const [resolvedDefaultEngine = APP_DEFAULTS.defaultModelId] =
      clampSelectedModelsAgainstRuntime([defaultEngine], runtimeModels, 1);
    const formattedConversations = conversations.map((conv) => {
      const selectedModels = clampSelectedModelsAgainstRuntime(
        safeParse(conv.selectedModels, [resolvedDefaultEngine]),
        runtimeModels
      );
      return {
        id: conv.id,
        title: conv.title,
        kind: conv.kind === "image" ? ("image" as const) : ("chat" as const),
        projectId: conv.projectId || null,
        selectedModels:
          selectedModels.length > 0 ? selectedModels : [resolvedDefaultEngine],
        disabledPanels: safeParse(conv.disabledPanels, []).filter((modelId) =>
          selectedModels.includes(modelId)
        ),
        // Normalized rather than echoed: the column still accepts the
        // retired "auto", and a client reading it back would render a switch
        // that is on for a state whose whole meaning was "ask me first".
        webSearchMode: normalizeWebSearchMode(conv.webSearchMode),
        isLocked: !!conv.password,
        shareEnabled:
          conv.shareEnabled &&
          !!conv.shareExpiresAt &&
          conv.shareExpiresAt > new Date(),
        shareExpiresAt: conv.shareExpiresAt?.toISOString() || null,
        messageCount: conv._count.messages,
        // Server-decided, so the sidebar cannot open a continuation in the
        // workspace -- where the imported half it continues does not exist.
        surface: conversationSurface({
          hasContinuationBridge: conv.continuationBridge !== null,
        }),
        /*
          The imported conversation's name, for the client to display when
          this row still carries the placeholder the continuation writer
          wrote (lib/continuationDisplayTitle.ts).

          Withheld for a locked snapshot, whose title is part of the
          transcript the lock is withholding, and absent entirely once the
          source is deleted -- both leave the row on its translated fallback.
        */
        sourceTitle:
          conv.continuationBridge?.externalConversation?.password === null
            ? (conv.continuationBridge.externalConversation.title ?? null)
            : null,
      };
    });

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

/**
 * The compatibility path. Pinned to Review for the transition (decision record
 * v1.2 §6): a POST to /api/conversations carries nothing that could tell Chat
 * from Review -- the URL is the same from either screen -- so the product is
 * declared here rather than guessed from a Referer. New clients call
 * /api/products/{review,chat}/conversations.
 */
export async function POST(req: Request) {
  return createConversationForProduct(req, REVIEW_PRODUCT_KEY);
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

    const conversations = await prisma.conversation.findMany({
      where: { userId },
      select: { id: true, password: true },
    });
    const inaccessibleLockedConversation = conversations.find(
      (conversation) =>
        conversation.password &&
        !hasConversationUnlockGrant(
          req,
          userId,
          conversation.id,
          conversation.password
        )
    );
    if (inaccessibleLockedConversation) {
      return conversationLockedResponse();
    }
    if (conversations.length === 0) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    // Same DB-first tombstone order as the single-conversation delete: R2
    // keys are enqueued before the rows disappear, never deleted ahead of
    // the database.
    const result = await prisma.$transaction(async (tx) => {
      const conversationIds = conversations.map(
        (conversation) => conversation.id
      );
      await enqueueImageAssetCleanupForConversations(tx, conversationIds);
      await enqueueArtifactCleanupForConversations(tx, conversationIds);
      await enqueueMessageAttachmentCleanupForConversations(tx, conversationIds);
      await deleteDeepResearchJobsForConversations(tx, conversationIds);
      return tx.conversation.deleteMany({
        where: {
          userId,
          id: { in: conversationIds },
        },
      });
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
