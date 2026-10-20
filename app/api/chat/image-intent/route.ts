export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { isImageGenerationEnabledCached } from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { getUserBillingPlan, planAllowsFeature } from "@/lib/billingEntitlements";
import {
  chatImageTriageModelId,
  detectChatImageRequest,
} from "@/lib/chatImageIntent";
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
    // Review's selected chat models; their makers' image models make the image.
    chatModelIds: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  })
  .strict();

const notImage = () => NextResponse.json({ image: false });

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
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
      chatModelIds: body.chatModelIds,
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
