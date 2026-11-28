import { resolveChatRouteSession } from "@/lib/chatRouteSession";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  IMAGE_GROUP_READ_SELECT,
  serializeImageGroup,
} from "@/lib/imageGenerationRead";
import { prisma } from "@/lib/prisma";
import { DESKTOP_APP_ORIGIN } from "@/lib/desktopReadApiContract";
import {
  conversationLockedResponse,
  hasConversationUnlockGrant,
} from "@/lib/conversationLock";

// GET /api/images/groups/[groupId] -- the polling endpoint policy §11 asks
// for: "one group-level endpoint returns group, target and attempt state
// together". One request answers for the whole comparison, so watching a
// four-model group costs exactly what watching a one-model group costs.
//
// The by-id generation route stays: it is the recovery read for a single card
// whose signed asset URLs expired, and it is what a client that only kept a
// generation id can still ask.

type Params = { params: Promise<{ groupId: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const routeAuth = await resolveChatRouteSession(req);
        if (routeAuth.response) return routeAuth.response;
        const session = routeAuth.session;
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "image-generation-group-status", {
      minute: 60,
      day: 5_000,
    });

    const { groupId } = await params;
    const group = await prisma.imageGenerationGroup.findUnique({
      where: { id: groupId },
      select: IMAGE_GROUP_READ_SELECT,
    });
    // Ownership is decided on the group's own userId, not on any target's:
    // the group is the row the request names, and a not-found and a
    // not-yours answer the same way so neither confirms the other's id.
    if (!group || group.userId !== userId) {
      return NextResponse.json(
        {
          error: "Image generation group not found.",
          code: "IMAGE_GENERATION_GROUP_NOT_FOUND",
        },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    // The signed asset URLs below are the conversation's content. The desktop
    // never reads a locked conversation; the web reads it with the unlock
    // grant, as its attachments and generated files do. A group whose
    // conversation has no password (the image workspace, Studio) reads as before.
    const conversation = await prisma.conversation.findFirst({
      where: { id: group.conversationId, userId },
      select: { password: true, passwordVersion: true },
    });
    if (!conversation) {
      return NextResponse.json(
        {
          error: "Image generation group not found.",
          code: "IMAGE_GENERATION_GROUP_NOT_FOUND",
        },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (
      req.headers.get("origin") === DESKTOP_APP_ORIGIN
        ? conversation.password != null
        : !hasConversationUnlockGrant(
            req,
            userId,
            group.conversationId,
            conversation.password == null ? null : conversation.passwordVersion
          )
    ) {
      return conversationLockedResponse();
    }

    const generationIds = group.targets.flatMap((target) =>
      target.generations.map((generation) => generation.id)
    );
    const reservations = await prisma.imageCreditReservation.findMany({
      where: { generationId: { in: generationIds } },
      select: { generationId: true, reservedCredits: true, refundedAt: true },
    });

    return NextResponse.json(
      await serializeImageGroup(
        group,
        new Map(reservations.map((row) => [row.generationId, row]))
      ),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Image generation group status read failed:", error);
    return NextResponse.json(
      { error: "Failed to read image generation group." },
      { status: 500 }
    );
  }
}
