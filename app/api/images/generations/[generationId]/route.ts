export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  IMAGE_GENERATION_READ_SELECT,
  serializeImageGeneration,
} from "@/lib/imageGenerationRead";
import { prisma } from "@/lib/prisma";

// GET /api/images/generations/[generationId] -- the polling and recovery
// endpoint. A client that lost the POST response (tab closed, network drop)
// re-reads the persisted state here; a disconnect is never a cancellation
// (policy section 5). Asset access is short-TTL signed URLs behind the
// ownership check, never raw R2 keys.

type Params = { params: Promise<{ generationId: string }> };

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
    await consumeApiRateLimit(req, userId, "image-generation-status", {
      minute: 60,
      day: 5_000,
    });

    const { generationId } = await params;
    const generation = await prisma.imageGeneration.findUnique({
      where: { id: generationId },
      select: IMAGE_GENERATION_READ_SELECT,
    });
    if (!generation || generation.userId !== userId) {
      return NextResponse.json(
        { error: "Image generation not found.", code: "IMAGE_GENERATION_NOT_FOUND" },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    const reservation = await prisma.imageCreditReservation.findUnique({
      where: { generationId: generation.id },
      select: { reservedCredits: true, refundedAt: true },
    });

    return NextResponse.json(
      await serializeImageGeneration(generation, reservation),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Image generation status read failed:", error);
    return NextResponse.json(
      { error: "Failed to read image generation." },
      { status: 500 }
    );
  }
}
