/**
 * The one conversation-creation handler, parameterised by product.
 *
 * Product boundary decision record v1.2, §6. Three routes call it and each
 * passes its own module constant:
 *
 *   POST /api/products/review/conversations   -> "review"
 *   POST /api/products/chat/conversations     -> "chat"
 *   POST /api/conversations                   -> "review", the compatibility path
 *
 * The product comes from **which endpoint was called**, never from the
 * request. A body field, a `Referer` or any other header is the client's claim
 * about which screen it was on; a product identity derived from a claim is not
 * server-derived, and the whole point of writing the product into the row is
 * that a later reader can trust it. `createConversationSchema` is `.strict()`,
 * so a body that tries to carry a productKey is rejected rather than ignored.
 *
 * `POST /api/conversations` cannot tell Chat from Review -- the URL is the same
 * from either screen -- which is exactly why the product-specific endpoints
 * exist and why the old one is pinned to Review for the compatibility period
 * rather than left to guess.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { APP_DEFAULTS, WEB_SEARCH_MODES, isWebSearchMode } from "@/lib/appDefaults";
import {
  apiSecurityResponse,
  assertConversationCapacity,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { ASSISTANT_PROFILE_MODEL_UNAVAILABLE } from "@/lib/assistantProfileVersioning";
import { authOptions } from "@/lib/auth";
import {
  effectivePlanModelLimit,
  getUserBillingPlan,
  modelLimitResponse,
} from "@/lib/billingEntitlements";
import { createConversation } from "@/lib/conversationCreation";
import type { ConversationProductKey } from "@/lib/conversationProduct";
import {
  ConversationProfileError,
  readConversationProfile,
  resolveProfileBinding,
} from "@/lib/conversationProfileService";
import { clampRuntimeSelectedModels } from "@/lib/modelRegistry";
import { resolveNewConversationSelectedModels } from "@/lib/newConversationSelectedModels";
import { prisma } from "@/lib/prisma";

const modelSchema = z.string().min(1).max(120);

/**
 * `.strict()` on purpose: a body carrying `productKey` is rejected, not
 * ignored. Silently dropping it would let a client believe it had chosen a
 * product.
 */
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

export const createConversationForProduct = async (
  req: Request,
  productKey: ConversationProductKey
) => {
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
    // shared resolver -- the same start state the client shows, and the same
    // one `lib/externalContinuationService.ts` starts a continuation with
    // (docs/policy/external-conversation-continuation.md §8.3).
    const fallbackModels = body.selectedModels
      ? null
      : await resolveNewConversationSelectedModels({
          storedNewConversationModelIds:
            userSettings?.newConversationModelIds ?? null,
          defaultModelId: defaultEngine,
          planTier: billingPlan.tier,
        });

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
      // Policy: docs/policy/external-conversation-import-and-memory.md.
      // Every model this profile names is retired or delisted. Falling back
      // to the account default would be the substitution §14 refuses -- the
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
      return createConversation(tx, {
        userId,
        title,
        // Server constant, not the request body. This route predates the
        // product split and is kept as the Review creation path for the
        // compatibility period (decision record v1.2 §6): a POST to
        // /api/conversations cannot tell which screen it came from, and a
        // Referer or a body field would be the client's claim rather than a
        // server derivation.
        productKey,
        selectedModels,
        disabledPanels,
        webSearchMode,
        projectId: body.projectId || null,
        assistantProfileVersionId:
          binding.outcome === "bind" ? binding.profileVersionId : null,
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
};
