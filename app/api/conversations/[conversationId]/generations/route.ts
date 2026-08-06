export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { conversationKindNotSupportedResponse } from "@/lib/conversationKindGuard";
import {
  IMAGE_GENERATION_READ_SELECT,
  readImageComposerRestore,
  serializeImageGeneration,
} from "@/lib/imageGenerationRead";
import { prisma } from "@/lib/prisma";

// GET /api/conversations/[conversationId]/generations -- the history read for
// an image conversation. Image conversations have no Message rows; this is
// how the workspace rebuilds its timeline after a refresh or on another
// device. Owner-only, image-kind-only; a chat conversation answers with the
// same 409 the kind guard uses everywhere else.

type Params = { params: Promise<{ conversationId: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }
    const userId = session.user.id;
    await consumeApiRateLimit(req, userId, "image-generation-list", {
      minute: 30,
      day: 2_000,
    });

    const { conversationId } = await params;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userId: true, kind: true },
    });
    if (!conversation || conversation.userId !== userId) {
      return NextResponse.json(
        { error: "Conversation not found.", code: "CONVERSATION_NOT_FOUND" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (conversation.kind !== "image") {
      return conversationKindNotSupportedResponse();
    }

    const generations = await prisma.imageGeneration.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      select: IMAGE_GENERATION_READ_SELECT,
    });
    const reservations = await prisma.imageCreditReservation.findMany({
      where: { generationId: { in: generations.map((row) => row.id) } },
      select: { generationId: true, reservedCredits: true, refundedAt: true },
    });
    const reservationByGeneration = new Map(
      reservations.map((row) => [row.generationId, row])
    );

    // Carried on the history read rather than a second endpoint: the timeline
    // and the composer's starting state then come from one server moment, and
    // opening a conversation still costs one round trip.
    const composerRestore = await readImageComposerRestore(
      conversation.id
    );

    return NextResponse.json(
      {
        conversationId: conversation.id,
        composerRestore,
        generations: await Promise.all(
          generations.map((generation) =>
            serializeImageGeneration(
              generation,
              reservationByGeneration.get(generation.id) ?? null
            )
          )
        ),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Image generation list read failed:", error);
    return NextResponse.json(
      { error: "Failed to read image generations." },
      { status: 500 }
    );
  }
}
