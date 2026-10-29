export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { isImageGenerationEnabledCached } from "@/lib/appSettings";
import { getUserBillingPlan, planAllowsFeature } from "@/lib/billingEntitlements";
import {
  chatImageTriageModelId,
  detectChatImageRequest,
} from "@/lib/chatImageIntent";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";

// POST /api/chat/image-intent -- asks the Auto router's model whether a chat
// message is a request to create an image and, if so, which image model and
// preset it needs, so the composer can hand it to the image workspace instead
// of sending it to chat. Routing only: nothing is generated or charged here,
// and the workspace keeps its own price and consent rules.
//
// Answers `{ image: false }` without a model call to anyone the image
// workspace would refuse (flag off, plan without image generation, account
// restricted), so the call is never paid for a handoff that cannot happen.

const imageIntentSchema = z
  .object({
    text: z.string().max(8_000),
    // The Chat conversation the message is sent in; a follow-up such as
    // "make it bluer" reads its previous image from there.
    conversationId: z.string().trim().min(1).max(100).nullable().optional(),
    // The message carries a photo; the call then only decides whether to
    // edit it. Not trusted for anything else: the image turn finds the photo
    // from the saved message and refuses an edit without one.
    attachedPhoto: z.boolean().optional(),
  })
  .strict();

const notImage = () => NextResponse.json({ image: false });

export async function POST(req: Request) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }
    const userId = session.user.id;
    // Off costs nothing, not even the caller's rate-limit allowance.
    if (!(await chatImageTriageModelId())) return notImage();
    await consumeApiRateLimit(req, userId, "chat-image-intent", {
      minute: 30,
      day: 2_000,
    });
    const body = await readLimitedJson(req, 64 * 1024, imageIntentSchema);
    if (!body.text.trim()) return notImage();

    if (!(await isImageGenerationEnabledCached())) return notImage();
    try {
      await assertUserOperationalAccess(userId);
    } catch {
      return notImage();
    }
    if (!planAllowsFeature(await getUserBillingPlan(userId), "imageGeneration")) {
      return notImage();
    }

    const decision = await detectChatImageRequest({
      text: body.text,
      traceId: randomUUID(),
      userId,
      conversationId: body.conversationId ?? null,
      request: req,
      attachedPhoto: body.attachedPhoto === true,
    });
    return NextResponse.json(decision);
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error(
      JSON.stringify({
        event: "chat_image_intent_failed",
        error: error instanceof Error ? error.name : "unknown",
      })
    );
    return notImage();
  }
}
