export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { after } from "next/server";
import { NextResponse } from "next/server";
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
  processImageGenerationGroup,
  retryImageGenerationTarget,
} from "@/lib/imageGenerationService";

// POST /api/images/targets/[targetId]/retry -- re-run ONE failed model of a
// comparison group. The retry is a new attempt under the same target, never
// a new group and never a re-run of a target that already succeeded: the
// user keeps the results they have and pays only for the model that failed
// (policy v2 section 11 of docs/policy/image-generation.md).

const retrySchema = z
  .object({
    retryIdempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();

type Params = { params: Promise<{ targetId: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "image-generation-retry", {
      minute: 6,
      day: 500,
    });
    const body = await readLimitedJson(req, 4 * 1024, retrySchema);
    const { targetId } = await params;

    const result = await retryImageGenerationTarget({
      userId,
      targetId,
      retryIdempotencyKey: body.retryIdempotencyKey,
    });

    if (!result.reused) {
      const pending = result.targets
        .filter((target) => target.status === "pending")
        .map((target) => target.generationId);
      if (pending.length > 0) {
        after(() =>
          processImageGenerationGroup(pending).catch((error) =>
            console.error("Image generation retry processing failed:", error)
          )
        );
      }
    }

    return NextResponse.json(
      {
        generationId: result.generationId,
        groupId: result.groupId,
        conversationId: result.conversationId,
        status: result.status,
        reservedCredits: result.reservedCredits,
        targets: result.targets,
      },
      { status: result.reused ? 200 : 202 }
    );
  } catch (error) {
    // Reason code and layer only -- never the prompt (policy section 10).
    if (error instanceof ChatAccessError) {
      console.info(
        JSON.stringify({
          event: "image_generation_retry_rejected",
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
    console.error("Image generation retry failed:", error);
    return NextResponse.json(
      { error: "Failed to retry image generation." },
      { status: 500 }
    );
  }
}
