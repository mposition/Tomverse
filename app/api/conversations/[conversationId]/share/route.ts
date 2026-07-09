import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { createShareToken, isStrongShareToken } from "@/lib/shareTokens";

export async function POST(req: Request, context: any) {
  const session = await getServerSession(authOptions);
  if (!session?.user || !(session.user as any).id) {
    return NextResponse.json({ error: "Login required" }, { status: 401 });
  }

  const params = await context.params;
  const conversationId = params.conversationId;
  const userId = (session.user as any).id;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { userId: true, shareToken: true },
  });

  if (!conversation || conversation.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const shareToken = isStrongShareToken(conversation.shareToken)
    ? conversation.shareToken
    : createShareToken();

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      shareToken,
      shareEnabled: true,
      sharedAt: new Date(),
    },
    select: { shareToken: true },
  });

  const baseUrl =
    process.env.NEXT_PUBLIC_SHARE_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(req.url).origin;

  return NextResponse.json({
    url: `${baseUrl}/share/${updated.shareToken}`,
  });
}
