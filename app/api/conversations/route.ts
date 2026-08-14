export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { enqueueImageAssetCleanupForConversations } from "@/lib/imageAssetLifecycle";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS, WEB_SEARCH_MODES, isWebSearchMode } from "@/lib/appDefaults";
import {
  clampRuntimeSelectedModels,
  clampSelectedModelsAgainstRuntime,
  getRuntimeModels,
} from "@/lib/modelRegistry";
import { z } from "zod";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";
import {
  apiSecurityResponse,
  assertConversationCapacity,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  effectivePlanModelLimit,
  getUserBillingPlan,
  modelLimitResponse,
} from "@/lib/billingEntitlements";
import { resolveNewConversationModels } from "@/lib/newConversationModels";
import {
  ConversationProfileError,
  readConversationProfile,
  resolveProfileBinding,
} from "@/lib/conversationProfileService";
import { ASSISTANT_PROFILE_MODEL_UNAVAILABLE } from "@/lib/assistantProfileVersioning";

const modelSchema = z.string().min(1).max(120);
const createConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    selectedModels: z.array(modelSchema).max(APP_DEFAULTS.maxSelectedModels).optional(),
    disabledPanels: z.array(modelSchema).max(APP_DEFAULTS.maxSelectedModels).optional(),
    projectId: z.string().trim().min(1).max(100).optional(),
    webSearchMode: z.enum(WEB_SEARCH_MODES).optional(),
    // §14: a profile, never a version. The server writes down which revision
    // was current when it bound; a client that could name one could pin a
    // conversation to a draft or to a revision the owner has replaced.
    assistantProfileId: z.string().trim().min(1).max(100).optional(),
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
        webSearchMode: isWebSearchMode(conv.webSearchMode)
          ? conv.webSearchMode
          : APP_DEFAULTS.defaultWebSearchMode,
        isLocked: !!conv.password,
        shareEnabled:
          conv.shareEnabled &&
          !!conv.shareExpiresAt &&
          conv.shareExpiresAt > new Date(),
        shareExpiresAt: conv.shareExpiresAt?.toISOString() || null,
        messageCount: conv._count.messages,
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
    const billingPlan = await getUserBillingPlan(userId);
    const maxModels = effectivePlanModelLimit(billingPlan);

    // A create without a model array starts from the account's saved
    // new-conversation combination (null -> [defaultModel]), resolved by the
    // shared resolver -- the same start state the client shows.
    const fallbackModels = body.selectedModels
      ? null
      : resolveNewConversationModels({
          stored: userSettings?.newConversationModelIds ?? null,
          defaultModel: defaultEngine,
          models: await getRuntimeModels(),
          plan: billingPlan.tier,
        }).effectiveModelIds;

    // §14's pin, resolved before the models are clamped: a profile names the
    // models this assistant answers on, and a conversation that adopted the
    // profile and then ran on a different model would be one whose profile
    // model choice does nothing.
    const binding = await resolveProfileBinding({
      userId,
      requestedProfileId: body.assistantProfileId,
      boundProfileId: null,
    });
    const profileModels =
      binding.outcome === "bind" && binding.modelIds.length > 0
        ? [...binding.modelIds]
        : null;

    const normalizedModels = await clampRuntimeSelectedModels(
      profileModels || body.selectedModels || fallbackModels || [defaultEngine]
    );
    // Only when the client's own list is what was clamped. A profile's models
    // come from a published version rather than from this request, so
    // comparing them against `body.selectedModels` would refuse a valid
    // create for a mismatch the caller did not cause.
    if (
      !profileModels &&
      body.selectedModels &&
      normalizedModels.length !== new Set(body.selectedModels).size
    ) {
      return NextResponse.json({ error: "One or more selected models are unavailable." }, { status: 400 });
    }
    if (profileModels && normalizedModels.length === 0) {
      // Every model this profile names is retired or delisted. Falling back
      // to the account default would be the substitution §45 refuses -- the
      // conversation would look like the profile's and answer on a model the
      // profile never chose -- so the create is refused where the owner can
      // still go and republish.
      return NextResponse.json(
        {
          error: "The models this profile uses are no longer available.",
          code: ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
        },
        { status: 409 }
      );
    }
    const activeModels =
      normalizedModels.length > 0 ? normalizedModels : [defaultEngine];
    if (activeModels.length > maxModels) {
      return modelLimitResponse(maxModels);
    }
    const normalizedDisabled = Array.from(
      new Set(body.disabledPanels || [])
    ).filter((modelId) => activeModels.includes(modelId));
    const selectedModels = JSON.stringify(activeModels);
    const disabledPanels = JSON.stringify(normalizedDisabled);
    if (body.projectId) {
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
    }

    const webSearchMode = body.webSearchMode || APP_DEFAULTS.defaultWebSearchMode;

    const newConversation = await prisma.$transaction(async (tx) => {
      await assertConversationCapacity(tx, userId);
      return tx.conversation.create({
        data: {
          userId,
          title,
          selectedModels,
          disabledPanels,
          webSearchMode,
          projectId: body.projectId || null,
          assistantProfileVersionId:
            binding.outcome === "bind" ? binding.profileVersionId : null,
        },
      });
    });

      const formattedConversation = {
          ...newConversation,
          projectId: newConversation.projectId || null,
          selectedModels: safeParse(newConversation.selectedModels, [defaultEngine]),
          disabledPanels: safeParse(newConversation.disabledPanels, []),
          webSearchMode: isWebSearchMode(newConversation.webSearchMode)
            ? newConversation.webSearchMode
            : APP_DEFAULTS.defaultWebSearchMode,
          isLocked: !!newConversation.password,
          messageCount: 0,
          // Server-computed, so the screen never has to work out which
          // revision it pinned to or whether a newer one exists (§14).
          assistantProfile: await readConversationProfile({
            userId,
            profileVersionId: newConversation.assistantProfileVersionId,
          }),
          password: undefined
      };

      return NextResponse.json(formattedConversation);      
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof ConversationProfileError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
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
