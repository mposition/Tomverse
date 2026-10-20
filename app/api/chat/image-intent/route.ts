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
import { detectChatImageRequest } from "@/lib/chatImageIntent";
import { chatImageIntentModelId } from "@/lib/chatImageIntentCore";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";

// POST /api/chat/image-intent -- asks one small model whether a chat message is
// a request to create an image, so the composer can hand it to the image
// workspace instead of sending it to chat. Routing only: nothing is generated
// or charged here, and the workspace keeps its own price and consent rules.
//
// Answers `{ image: false }` without a model call to anyone the image
// workspace would refuse (flag off, plan without image generation, account
// restricted), so the call is never paid for a handoff that cannot happen.

const imageIntentSchema = z
  .object({ text: z.string().max(8_000) })
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
    if (!chatImageIntentModelId()) return notImage();
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

    const image = await detectChatImageRequest({
      text: body.text,
      traceId: randomUUID(),
    });
    return NextResponse.json({ image });
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
