import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { shareSnapshotSchema } from "@/lib/shareSnapshot";
import { isStrongShareToken } from "@/lib/shareTokens";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";

export async function GET(
  req: Request,
  context: { params: Promise<{ shareToken: string }> }
) {
  try {
    const { shareToken } = await context.params;
    if (!isStrongShareToken(shareToken)) {
      return NextResponse.json(
        { error: "Shared conversation not found." },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    await consumeApiRateLimit(
      req,
      `public-share:${shareToken}`,
      "public-share-read",
      { minute: 120, day: 5_000 }
    );

    const conversation = await prisma.conversation.findFirst({
      where: {
        shareToken,
        shareEnabled: true,
        shareExpiresAt: { gt: new Date() },
      },
      select: {
        shareSnapshot: true,
        shareExpiresAt: true,
      },
    });
    const snapshot = shareSnapshotSchema.safeParse(
      conversation?.shareSnapshot
    );
    if (!conversation?.shareExpiresAt || !snapshot.success) {
      return NextResponse.json(
        { error: "Shared conversation not found." },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    return NextResponse.json(
      {
        snapshot: snapshot.data,
        expiresAt: conversation.shareExpiresAt.toISOString(),
      },
      {
        headers: {
          "Cache-Control":
            "public, max-age=0, s-maxage=30, stale-while-revalidate=15",
          "CDN-Cache-Control":
            "public, s-maxage=30, stale-while-revalidate=15",
          "Cloudflare-CDN-Cache-Control":
            "public, s-maxage=30, stale-while-revalidate=15",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) {
      securityResponse.headers.set("Cache-Control", "no-store");
      return securityResponse;
    }
    console.error("Public shared conversation lookup failed:", error);
    return NextResponse.json(
      { error: "Failed to load shared conversation." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
