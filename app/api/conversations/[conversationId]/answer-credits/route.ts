export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readSettledAnswerCredits } from "@/lib/chatAnswerCredits";
import { parseAnswerCreditIds } from "@/lib/chatAnswerCreditsCore";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { conversationLockedResponse, hasConversationUnlockGrant } from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";

/**
 * What these answers were charged, once their settlement is final.
 *
 * The browser asks right after an answer finishes streaming, because the
 * settlement lands just after the last token and the transcript it already
 * holds has no figure. A history load gets the same numbers on the
 * conversation read itself (app/api/conversations/[conversationId]).
 *
 * Read-only and owner-only: the conversation must be this user's, unlocked
 * and a Chat conversation; only its own answers are looked up; and only this
 * user's reservations count (lib/chatAnswerCredits.ts). An answer that is not
 * settled yet, cost nothing or predates the link is simply absent.
 */
type Params = { params: Promise<{ conversationId: string }> };

const privateNoStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(req: Request, { params }: Params) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) {
      return privateNoStore(
        NextResponse.json({ error: "Authentication required." }, { status: 401 })
      );
    }
    await consumeApiRateLimit(req, userId, "conversation-answer-credits", {
      minute: 120,
      day: 10_000,
    });

    const { conversationId } = await params;
    const ids = parseAnswerCreditIds(new URL(req.url).searchParams.get("ids"));
    if (!conversationId || !ids) {
      return privateNoStore(
        NextResponse.json({ error: "Invalid answer ids." }, { status: 400 })
      );
    }
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        userId: true,
        kind: true,
        productKey: true,
        password: true,
        passwordVersion: true,
      },
    });
    if (!conversation || conversation.userId !== userId) {
      return privateNoStore(
        NextResponse.json(
          { error: "You do not have access to this conversation." },
          { status: 403 }
        )
      );
    }
    if (
      !hasConversationUnlockGrant(
        req,
        userId,
        conversationId,
        conversation.password == null ? null : conversation.passwordVersion
      )
    ) {
      return privateNoStore(conversationLockedResponse());
    }
    if (conversation.kind !== "chat" || conversation.productKey !== "chat") {
      return privateNoStore(NextResponse.json({ credits: {} }));
    }

    const answers = await prisma.message.findMany({
      where: { conversationId, role: "assistant", id: { in: ids } },
      select: { id: true },
    });
    const credits = await readSettledAnswerCredits(
      userId,
      answers.map((answer) => answer.id)
    );
    return privateNoStore(NextResponse.json({ credits: Object.fromEntries(credits) }));
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return privateNoStore(securityResponse);

    console.error("Failed to read answer credits:", error);
    return privateNoStore(
      NextResponse.json({ error: "Failed to read answer credits." }, { status: 500 })
    );
  }
}
