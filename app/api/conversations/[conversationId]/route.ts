export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { enqueueImageAssetCleanupForConversations } from "@/lib/imageAssetLifecycle";
import { enqueueArtifactCleanupForConversations } from "@/lib/generatedArtifactStorage";
import { PUBLIC_MESSAGE_ATTACHMENT_SELECT } from "@/lib/messageAttachmentCore";
import { enqueueMessageAttachmentCleanupForConversations } from "@/lib/messageAttachmentStorage";
import { deleteDeepResearchJobsForConversations } from "@/lib/deepResearchJobs";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS, normalizeWebSearchMode, WEB_SEARCH_MODES } from "@/lib/appDefaults";
import {
  CONVERSATION_MEMORY_MODES,
  DEFAULT_CONVERSATION_MEMORY_MODE,
  isConversationMemoryMode,
} from "@/lib/conversationMemoryMode";
import { recordConversationMemoryOff } from "@/lib/memoryModeSignals";
import {
  ConversationProfileError,
  readConversationProfile,
  resolveProfileBinding,
} from "@/lib/conversationProfileService";
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
import {
    SELECTION_MODES,
    selectionModeTransition,
    storedSelectionMode,
} from "@/lib/conversationSelectionMode";
import { autoAvailabilityFor } from "@/lib/autoAvailability";
import {
    autoSelectionCapability,
    mayStoreSelectionMode,
} from "@/lib/autoRoutingUi";
import { describeAutoCohortRefusal } from "@/lib/autoCohort";

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
    webSearchMode: z.enum(WEB_SEARCH_MODES).optional(),
    memoryMode: z.enum(CONVERSATION_MEMORY_MODES).optional(),
    selectionMode: z.enum(SELECTION_MODES).optional(),
    // §14: a profile id, or null to detach. Never a version id -- the server
    // decides which revision is current, and re-sending the same profile id
    // is how the explicit move to a newer revision is expressed.
    assistantProfileId: z
      .union([z.string().trim().min(1).max(100), z.null()])
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.title !== undefined ||
      body.password !== undefined ||
      body.selectedModels !== undefined ||
      body.disabledPanels !== undefined ||
      body.projectId !== undefined ||
      body.webSearchMode !== undefined ||
      body.memoryMode !== undefined ||
      body.selectionMode !== undefined ||
      body.assistantProfileId !== undefined,
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
        kind: true,
        selectedModels: true,
        disabledPanels: true,
        webSearchMode: true,
        memoryMode: true,
        productKey: true,
        selectionMode: true,
        projectId: true,
        shareEnabled: true,
        shareExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        password: true,
        assistantProfileVersionId: true,
        assistantProfileRemovedAt: true,
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
        pendingJobId: true,
        searchMetadata: true,
        createdAt: true,
        // §13.4. The count only, never `memoryTokens`: the disclosure states
        // how many memories an answer was given, and a token figure would
        // say something about their length without being asked for.
        memoryUsedCount: true,
        // docs/policy/external-conversation-import-and-memory.md §14.3, selected on the same terms and for the
        // same reason: the
        // owner's own read is the one place this count is admissible.
        knowledgeChunkCount: true,
        /*
          The files this answer produced
          (docs/policy/generated-artifacts.md section 5).

          A named select rather than `include: { artifacts: true }`, because
          `objectKey` is on that row and an include would send it. The client
          needs the id to build a download URL and nothing else about where
          the bytes live.
        */
        artifacts: {
          orderBy: { ordinal: "asc" },
          select: {
            id: true,
            ordinal: true,
            format: true,
            filename: true,
            mediaType: true,
            byteSize: true,
            status: true,
            failureCode: true,
            modelId: true,
          },
        },
        /*
          The files the *user* attached to this message
          (docs/policy/user-attachment-persistence.md).

          A named select for the same reason the artifacts above use one, and
          it matters more here: `objectKey` is on this row and is the private
          storage location of a file the user uploaded. `include` would send
          it. What the card needs is the name, the type and the size, which is
          exactly `PUBLIC_MESSAGE_ATTACHMENT_SELECT` -- the bytes, the
          extracted text, the paths inside an uploaded archive and any signed
          URL are all absent because none of them is on this list.
        */
        attachments: {
          orderBy: { ordinal: "asc" },
          select: PUBLIC_MESSAGE_ATTACHMENT_SELECT,
        },
      },
    });
    const hasMoreMessages = messagePage.length > MESSAGE_PAGE_SIZE;
    const messages = (
      hasMoreMessages ? messagePage.slice(0, MESSAGE_PAGE_SIZE) : messagePage
    ).map(
      ({
        memoryUsedCount,
        knowledgeChunkCount,
        artifacts,
        attachments,
        ...message
      }) => ({
      ...message,
      /*
        Absent, not empty, when the user attached nothing -- the same shape a
        live send produces, so a restored message and one that has just been
        sent are indistinguishable to the renderer.

        `attachmentId` repeats the row id under the name the *request* uses.
        The card keys on `id`; the next turn has to name the file for the
        server to re-read, and it names it with `attachmentId`
        (docs/policy/user-attachment-persistence.md section 4). Sending the
        one field twice is what stops the client having to know that the two
        are the same thing -- a piece of knowledge that would only ever live
        in one place until somebody moved it.
      */
      ...(attachments.length
        ? {
            attachments: attachments.map((attachment) => ({
              ...attachment,
              attachmentId: attachment.id,
            })),
          }
        : {}),
      // Absent, not empty, when the answer produced no file -- the same
      // shape the streaming trailer uses, so a restored message and a live
      // one are indistinguishable to the renderer.
      ...(artifacts.length ? { artifacts } : {}),
      /*
        §13.4: a durable fact about the answer, so reopening the conversation
        has to state it again. Until this it lived only in the streaming
        response header, which meant the disclosure was true while the answer
        was being written and silently gone on the next visit.

        Sent on exactly the condition the header uses, so the two paths cannot
        disagree: `null` is a request that could not inject at all and `0` is
        one where retrieval chose nothing, and §13.4 forbids indicating
        either. Both leave the field off rather than sending a number the
        renderer has to know not to show.

        Ownership and the lock grant are re-checked above, and this route is
        the owner's own read -- the share snapshot and the conversation export
        keep their own selects, which do not name this column (§13.3).
      */
      ...(typeof memoryUsedCount === "number" && memoryUsedCount > 0
        ? { memoryUsedCount }
        : {}),
      /*
        docs/policy/external-conversation-import-and-memory.md §14.3: the knowledge half of the same
        disclosure, on the identical
        condition. Destructured above so that a `null` or `0` is dropped
        here rather than reaching the client -- the field is absent, never a
        number the renderer has to know not to show.
      */
      ...(typeof knowledgeChunkCount === "number" && knowledgeChunkCount > 0
        ? { knowledgeChunkCount }
        : {}),
      })
    );

    const selectedModels = await clampRuntimeSelectedModels(
      safeParse(conversation.selectedModels, [defaultEngine])
    );
    return NextResponse.json({
      ...conversation,
        messages,
        kind:
          conversation.kind === "image" ? ("image" as const) : ("chat" as const),
        projectId: conversation.projectId || null,
        messagePage: {
          hasMore: hasMoreMessages,
          nextCursor: hasMoreMessages ? messages.at(-1)?.id || null : null,
        },
        selectedModels,
        disabledPanels: safeParse(conversation.disabledPanels, []).filter(
          (modelId: string) => selectedModels.includes(modelId)
        ),
        // The stored value, `inherit` included: resolving it here would hide
        // from the client whether this conversation follows the account
        // default or overrides it (§8.1 invariant 1).
        memoryMode: isConversationMemoryMode(conversation.memoryMode)
          ? conversation.memoryMode
          : DEFAULT_CONVERSATION_MEMORY_MODE,
        // See the list route: "auto" is still storable and is read as off.
        webSearchMode: normalizeWebSearchMode(conversation.webSearchMode),
        // The stored mode, and whether this account would be offered Auto at
        // all. `offered` is one boolean by design: the refusals are internal
        // rollout state (which bucket, what share, which gate), and a client
        // that could read its own bucket could work out the rollout
        // percentage. See lib/autoRoutingUi.ts.
        selectionMode: storedSelectionMode(conversation.selectionMode),
        // The product comes before the cohort (decision record v1.2 §3), and
        // it is the row's own -- never the surface the client was on.
        autoSelection: autoSelectionCapability(
          await autoAvailabilityFor(userId, { productKey: conversation.productKey })
        ),
        isLocked: !!conversation.password,
        shareEnabled:
          conversation.shareEnabled &&
          !!conversation.shareExpiresAt &&
          conversation.shareExpiresAt > new Date(),
        shareExpiresAt: conversation.shareExpiresAt?.toISOString() || null,
        // Server-computed (§14): which revision this conversation pinned to,
        // and whether the profile has since published a newer one. A screen
        // that worked this out for itself would be a second implementation of
        // the pinning rule.
        assistantProfile: await readConversationProfile({
          userId,
          profileVersionId: conversation.assistantProfileVersionId,
        }),
        // A sibling of `assistantProfile`, not a field inside it: it is
        // present exactly when that one is null and the reason for the null is
        // a deletion. Folding it in would mean inventing a profile object to
        // carry the fact that there is no profile.
        assistantProfileRemovedAt:
          conversation.assistantProfileRemovedAt?.toISOString() ?? null,
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
            select: {
                userId: true,
                selectedModels: true,
                password: true,
                memoryMode: true,
                // The stored product is the authority for a PATCH: the request
                // body cannot carry one, and §3 does not offer a PATCH that
                // changes it. Turning a Review conversation into a Chat one is
                // a fork, not an update.
                productKey: true,
                selectionMode: true,
                routerModelId: true,
                routerChallengerTurns: true,
                assistantProfileVersionId: true,
                assistantProfileRemovedAt: true,
                assistantProfileVersion: { select: { profileId: true } },
            }
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

    if (body.webSearchMode !== undefined) {
      updateData.webSearchMode = body.webSearchMode;
    }

    if (body.memoryMode !== undefined) {
      updateData.memoryMode = body.memoryMode;
    }

    // §14. Re-sending the same profile id is not a no-op: it is how the owner
    // moves this conversation onto a revision they have since published. The
    // pinned version id is what decides whether anything changed, which is
    // why the comparison is here and not in the planner.
    if (body.assistantProfileId !== undefined) {
      // Any deliberate move of the binding ends the deletion's claim on this
      // conversation, in both directions: attaching a new assistant, and
      // detaching on purpose. `어시스턴트가 삭제되었습니다` explains a state
      // the owner did not choose; once they have chosen one, it does not.
      //
      // Written unconditionally rather than only when the binding changes.
      // Re-selecting the same profile is `unchanged` and writes nothing else,
      // but a conversation whose assistant was deleted cannot be bound to that
      // profile any more -- so an `unchanged` outcome here means the tombstone
      // was already clear, and setting null again costs nothing.
      updateData.assistantProfileRemovedAt = null;
      const binding = await resolveProfileBinding({
        userId,
        requestedProfileId: body.assistantProfileId,
        boundProfileId: existingConv.assistantProfileVersion?.profileId ?? null,
      });
      if (binding.outcome === "bind") {
        if (binding.profileVersionId !== existingConv.assistantProfileVersionId) {
          updateData.assistantProfileVersion = {
            connect: { id: binding.profileVersionId },
          };
        }
        // `binding.modelIds` is deliberately not applied here. Only a
        // conversation being created adopts the profile's models; binding to
        // an existing one preserves whatever the user already chose, because
        // replacing them would change this conversation's per-turn cost,
        // answer characteristics and panel layout without anyone asking.
        // Applying them is a separate explicit action (#643), and this branch
        // must keep writing the profile version and nothing else.
      } else if (binding.outcome === "detach") {
        updateData.assistantProfileVersion = { disconnect: true };
      }
    }

    if (body.selectionMode !== undefined) {
      // `auto` is refused unless this account would actually be routed.
      // Storing it anyway would leave a conversation marked Auto that every
      // turn answers manually, which the user cannot distinguish from Auto
      // choosing their model every time. `manual` is always allowed --
      // including for an account that has left the cohort, which must be able
      // to leave the mode it can no longer act on (lib/autoRoutingUi.ts).
      const availability = await autoAvailabilityFor(userId, { productKey: existingConv.productKey });
      if (!mayStoreSelectionMode(body.selectionMode, availability)) {
        console.warn(JSON.stringify({
          event: "conversation_selection_mode_denied",
          code: "AUTO_SELECTION_UNAVAILABLE",
          conversationId,
          reason: availability.reason,
          detail: availability.cohort && !availability.cohort.eligible
            ? describeAutoCohortRefusal(availability.cohort)
            : null,
          timestamp: new Date().toISOString(),
        }));
        return NextResponse.json(
          {
            error: "Automatic model selection is not available for this account.",
            code: "AUTO_SELECTION_UNAVAILABLE",
          },
          { status: 403 }
        );
      }

      // The transition, not a bare column write: returning to manual has to
      // clear the sticky model and the challenger streak, and the database
      // refuses the row if it does not
      // (`Conversation_manual_has_no_sticky_state_check`).
      const transition = selectionModeTransition(existingConv, body.selectionMode);
      Object.assign(updateData, transition.patch);
      if (transition.clearedStickyState) {
        console.info(JSON.stringify({
          event: "conversation_router_sticky_cleared",
          conversationId,
          previousModelId: existingConv.routerModelId,
          previousChallengerTurns: existingConv.routerChallengerTurns,
          timestamp: new Date().toISOString(),
        }));
      }
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
    if (body.memoryMode !== undefined) {
      // After the write, and never allowed to fail it: the user's choice is
      // already saved, and §22 observation must not be able to undo it.
      await recordConversationMemoryOff({
        conversationId,
        previousMode: existingConv.memoryMode,
        nextMode: body.memoryMode,
      });
    }
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
        memoryMode: isConversationMemoryMode(updatedConversation.memoryMode)
          ? updatedConversation.memoryMode
          : DEFAULT_CONVERSATION_MEMORY_MODE,
        webSearchMode: normalizeWebSearchMode(updatedConversation.webSearchMode),
        isLocked: !!updatedConversation.password,
        shareEnabled:
          updatedConversation.shareEnabled &&
          !!updatedConversation.shareExpiresAt &&
          updatedConversation.shareExpiresAt > new Date(),
        shareExpiresAt:
          updatedConversation.shareExpiresAt?.toISOString() || null,
        assistantProfile: await readConversationProfile({
          userId,
          profileVersionId: updatedConversation.assistantProfileVersionId,
        }),
        // A sibling of `assistantProfile`, not a field inside it: it is
        // present exactly when that one is null and the reason for the null is
        // a deletion. Folding it in would mean inventing a profile object to
        // carry the fact that there is no profile.
        assistantProfileRemovedAt:
          updatedConversation.assistantProfileRemovedAt?.toISOString() ?? null,
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

    if (error instanceof ConversationProfileError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }

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

    // DB-first tombstone: generated-image R2 keys are enqueued for cleanup
    // in the same transaction that deletes the rows, and the fifteen-minute
    // maintenance sweep deletes the objects afterwards. Deleting R2 first
    // and the rows second would leave the database pointing at missing
    // objects whenever the second step failed.
    await prisma.$transaction(async (tx) => {
      await enqueueImageAssetCleanupForConversations(tx, [conversationId]);
      // Generated files follow the same order for the same reason
      // (docs/policy/generated-artifacts.md section 8).
      await enqueueArtifactCleanupForConversations(tx, [conversationId]);
      // And the files the user uploaded into it. Deleting the conversation is
      // the only ordinary act that removes them: clearing one model's answers
      // must not, because the attachment belongs to the question every model
      // in the comparison shares
      // (docs/policy/user-attachment-persistence.md).
      await enqueueMessageAttachmentCleanupForConversations(tx, [conversationId]);
      await deleteDeepResearchJobsForConversations(tx, [conversationId]);
      await tx.conversation.delete({
        where: { id: conversationId },
      });
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
