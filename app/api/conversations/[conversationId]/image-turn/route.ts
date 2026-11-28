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
  ApiSecurityError,
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { chatErrorResponse } from "@/lib/chatSecurity";
import { chatImageTurnGroupReserved, startChatImageTurn } from "@/lib/chatImageTurn";
import { reviewPanelIndex } from "@/lib/chatImageTurnCore";
import { processImageGenerationGroup } from "@/lib/imageGenerationService";
import { IMAGE_ROUTING_DECISION_ID_PATTERN, linkImageRoutingDecision } from "@/lib/imageRoutingDecisions";

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
    // Each Review panel's chat model, in imageGroupModelIds order: the
    // request that reserves the group writes every panel's answer with it.
    imageGroupPanelModelIds: z.array(z.string().trim().min(1).max(120)).min(1).max(8).optional(),
    preset: z.enum(["draft", "standard", "final"]).nullable(),
    // A follow-up's prompt, rewritten by the image-intent call from the
    // previous image ("make it bluer"). The user's own text either way --
    // the image workspace takes any prompt they type -- so nothing is
    // widened by accepting it here.
    prompt: z.string().trim().min(1).max(4_000).optional(),
    // Edit the photo attached to the saved question. Only a flag: the server
    // finds the photo from the question itself.
    edit: z.boolean().optional(),
    // The routing decision this turn answers (content-free); linked to the
    // group only when it is this person's own image decision.
    routingDecisionId: z.string().regex(IMAGE_ROUTING_DECISION_ID_PATTERN).optional(),
  })
  .strict();

type Params = { params: Promise<{ conversationId: string }> };

/**
 * Whether this is the first request to bind this panel id: one per panel per
 * period, as a bucket of one keyed on the user and the answer id. Its own
 * scope and no per-IP leg, so it never draws on the image allowance and the
 * panels of one turn never throttle each other. A refusal means the panel has
 * bound before; anything else is an error like any other.
 */
const firstBindOfPanel = async (req: Request, userId: string, assistantMessageId: string) => {
  try {
    await consumeApiRateLimit(req, `${userId}:${assistantMessageId}`, "image-turn-panel-bind",
      { minute: 1, day: 1 }, { skipIpBucket: true });
    return true;
  } catch (error) {
    if (error instanceof ApiSecurityError && error.status === 429) return false;
    throw error;
  }
};

export async function POST(req: Request, { params }: Params) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const session = authentication.session;
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    const userId = session.user.id;
    // Room for a follow-up prompt of 4,000 characters in any script.
    const body = await readLimitedJson(req, 16 * 1024, imageTurnSchema);
    const { conversationId } = await params;
    // The same allowance as the image workspace's own submit -- which is one
    // submit per group. A later Review panel of a group another panel already
    // reserved buys nothing (requestImageGeneration replays the group), so its
    // first request is not counted: refusing it showed a failure beside an
    // image that was paid for. Only that first one, and only for a well-formed
    // panel of that group (reviewPanelIndex, checked inside): a repeat of a
    // panel that has bound already -- or any request naming the group some
    // other way -- is counted like any other, so knowing a reserved group's
    // ids is no way around the allowance.
    const bindsReservedGroup = Boolean(
      body.imageGroupModelIds &&
      reviewPanelIndex(body.assistantMessageId, body.imageGroupModelIds.length) !== null &&
      await chatImageTurnGroupReserved({
        userId,
        conversationId,
        assistantMessageId: body.assistantMessageId,
        panelCount: body.imageGroupModelIds.length,
      }) &&
      await firstBindOfPanel(req, userId, body.assistantMessageId)
    );
    if (!bindsReservedGroup) {
      await consumeApiRateLimit(req, userId, "image-generation", {
        minute: 6,
        day: 500,
      });
    }

    const turn = await startChatImageTurn({
      userId,
      conversationId,
      sourceUserMessageId: body.sourceUserMessageId,
      assistantMessageId: body.assistantMessageId,
      modelId: body.modelId,
      imageModelIds: body.imageModelIds,
      ...(body.imageGroupModelIds ? { imageGroupModelIds: body.imageGroupModelIds } : {}),
      ...(body.imageGroupPanelModelIds ? { imageGroupPanelModelIds: body.imageGroupPanelModelIds } : {}),
      preset: body.preset,
      prompt: body.prompt,
      ...(body.edit ? { edit: true } : {}),
      request: req,
    });

    if (body.routingDecisionId) {
      await linkImageRoutingDecision({ decisionId: body.routingDecisionId, userId, groupId: turn.groupId });
    }

    // Post-response execution, as in POST /api/images/generations: a process
    // death here is the stale case the reconciliation sweep refunds. A bind to
    // a group another panel reserved starts nothing: that request scheduled
    // its group's work, and an uncounted request must not be a way to queue it
    // again. A counted retry still starts work that never ran.
    if (!bindsReservedGroup && turn.pendingGenerationIds.length > 0) {
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
