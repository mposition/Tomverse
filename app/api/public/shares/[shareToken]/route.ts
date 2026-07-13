import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { shareSnapshotSchema } from "@/lib/shareSnapshot";
import { isStrongShareToken } from "@/lib/shareTokens";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";

const publicShareHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
} as const;

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
          headers: publicShareHeaders,
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
          headers: publicShareHeaders,
        }
      );
    }

    return NextResponse.json(
      {
        snapshot: snapshot.data,
        expiresAt: conversation.shareExpiresAt.toISOString(),
      },
      {
        headers: publicShareHeaders,
      }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) {
      for (const [name, value] of Object.entries(publicShareHeaders)) {
        securityResponse.headers.set(name, value);
      }
      return securityResponse;
    }
    console.error("Public shared conversation lookup failed:", error);
    return NextResponse.json(
      { error: "Failed to load shared conversation." },
      {
        status: 500,
        headers: publicShareHeaders,
      }
    );
  }
}
