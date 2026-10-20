export const dynamic = "force-dynamic";

/**
 * The executor budget `after()` gets, as for POST /api/images/generations:
 * `IMAGE_EXECUTOR_MAX_DURATION_SECONDS`, kept in step by
 * `npm run check:image-executor-budget`.
 */
export const maxDuration = 968;

import { after, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { startChatImageTurn } from "@/lib/chatImageTurn";
import { processImageGenerationGroup } from "@/lib/imageGenerationService";

// POST /api/conversations/[conversationId]/image-turn -- answers a saved
// Tomverse Chat question with an image in the same conversation, instead of
// a text answer from /api/chat. The image is reserved and charged through
// requestImageGeneration exactly as the image workspace's is; the response
// names the group the transcript card polls (GET /api/images/groups/[id]).

const imageTurnSchema = z
  .object({
    sourceUserMessageId: z.string().trim().min(1).max(100),
    assistantMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    modelId: z.string().trim().min(1).max(120),
    imageModelIds: z.array(z.string().trim().min(1).max(120)).max(8),
    preset: z.enum(["draft", "standard", "final"]).nullable(),
  })
  .strict();

type Params = { params: Promise<{ conversationId: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;
    // The same allowance as the image workspace's own submit.
    await consumeApiRateLimit(req, userId, "image-generation", {
      minute: 6,
      day: 500,
    });
    const body = await readLimitedJson(req, 4 * 1024, imageTurnSchema);
    const { conversationId } = await params;

    const turn = await startChatImageTurn({
      userId,
      conversationId,
      sourceUserMessageId: body.sourceUserMessageId,
      assistantMessageId: body.assistantMessageId,
      modelId: body.modelId,
      imageModelIds: body.imageModelIds,
      preset: body.preset,
    });

    // Post-response execution, as in POST /api/images/generations: a process
    // death here is the stale case the reconciliation sweep refunds.
    if (turn.pendingGenerationIds.length > 0) {
      after(() =>
        processImageGenerationGroup(turn.pendingGenerationIds).catch((error) =>
          console.error("Chat image turn processing failed:", error)
        )
      );
    }

    return NextResponse.json(
      { content: turn.content, imageTurn: { groupId: turn.groupId } },
      { status: 202 }
    );
  } catch (error) {
    const chatResponse = chatErrorResponse(error);
    if (chatResponse) return chatResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Chat image turn failed:", error);
    return NextResponse.json({ error: "Failed to start the image." }, { status: 500 });
  }
}
