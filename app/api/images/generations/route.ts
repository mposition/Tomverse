export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { after } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { ChatAccessError, chatErrorResponse } from "@/lib/chatSecurity";
import {
  processImageGeneration,
  requestImageGeneration,
} from "@/lib/imageGenerationService";

// POST /api/images/generations -- the only way an image conversation comes
// into existence. Both gates (the default-off operational flag and the
// Pro/Max plan entitlement) are enforced inside requestImageGeneration from
// this first commit; UI non-exposure is not a security boundary.
// Policy: docs/policy/image-generation.md sections 2 and 6-7.

const createGenerationSchema = z
  .object({
    prompt: z.string().trim().min(1).max(8_000),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536"]),
    quality: z.enum(["low", "medium", "high"]),
    conversationId: z.string().trim().min(1).max(100).optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

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
    await consumeApiRateLimit(req, userId, "image-generation", {
      minute: 6,
      day: 500,
    });
    const body = await readLimitedJson(req, 32 * 1024, createGenerationSchema);

    const result = await requestImageGeneration({
      userId,
      prompt: body.prompt,
      size: body.size,
      quality: body.quality,
      conversationId: body.conversationId ?? null,
      idempotencyKey: body.idempotencyKey,
    });

    // Post-response execution in the same long-lived Node process: the 202
    // is already on the wire, so the Cloudflare proxy read timeout no longer
    // applies, and the claim inside processImageGeneration keeps this safe
    // to run alongside the reconciliation sweep (or a future dedicated
    // worker). A process death here is exactly the stale case the sweep
    // refunds.
    if (!result.reused && result.status === "pending") {
      after(() =>
        processImageGeneration(result.generationId).catch((error) =>
          console.error("Image generation processing failed:", error)
        )
      );
    }

    return NextResponse.json(
      {
        generationId: result.generationId,
        conversationId: result.conversationId,
        status: result.status,
        reservedCredits: result.reservedCredits,
      },
      { status: result.reused ? 200 : 202 }
    );
  } catch (error) {
    // Row-less preflight rejections are observable only here: reason code
    // and layer, never the prompt or any part of it
    // (docs/policy/image-generation.md section 10).
    if (error instanceof ChatAccessError) {
      console.info(
        JSON.stringify({
          event: "image_generation_preflight_rejected",
          code: error.code,
          status: error.status,
          occurredAt: new Date().toISOString(),
        })
      );
    }
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Image generation request failed:", error);
    return NextResponse.json(
      { error: "Failed to start image generation." },
      { status: 500 }
    );
  }
}
