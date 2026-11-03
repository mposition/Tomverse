export const dynamic = "force-dynamic";

/**
 * The executor budget `after()` gets, as for POST /api/images/generations:
 * `IMAGE_EXECUTOR_MAX_DURATION_SECONDS`, kept in step by
 * `npm run check:image-executor-budget`.
 */
export const maxDuration = 968;

import { after, NextResponse } from "next/server";
import { z } from "zod";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
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
    imageGroupModelIds: z.array(z.string().trim().min(1).max(120)).min(1).max(8).optional(),
    preset: z.enum(["draft", "standard", "final"]).nullable(),
    // A follow-up's prompt, rewritten by the image-intent call from the
    // previous image ("make it bluer"). The user's own text either way --
    // the image workspace takes any prompt they type -- so nothing is
    // widened by accepting it here.
    prompt: z.string().trim().min(1).max(4_000).optional(),
    // Edit the photo attached to the saved question. Only a flag: the server
    // finds the photo from the question itself.
    edit: z.boolean().optional(),
  })
  .strict();

type Params = { params: Promise<{ conversationId: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;
    // The same allowance as the image workspace's own submit.
    await consumeApiRateLimit(req, userId, "image-generation", {
      minute: 6,
      day: 500,
    });
    // Room for a follow-up prompt of 4,000 characters in any script.
    const body = await readLimitedJson(req, 16 * 1024, imageTurnSchema);
    const { conversationId } = await params;

    const turn = await startChatImageTurn({
      userId,
      conversationId,
      sourceUserMessageId: body.sourceUserMessageId,
      assistantMessageId: body.assistantMessageId,
      modelId: body.modelId,
      imageModelIds: body.imageModelIds,
      ...(body.imageGroupModelIds ? { imageGroupModelIds: body.imageGroupModelIds } : {}),
      preset: body.preset,
      prompt: body.prompt,
      ...(body.edit ? { edit: true } : {}),
      request: req,
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
      {
        content: turn.content,
        imageTurn: { groupId: turn.groupId, modelIds: turn.imageModelIds },
      },
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
