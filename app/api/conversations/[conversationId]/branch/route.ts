import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { validBranchTemplate } from "@/lib/chatBranchCore";
import { BRANCH_REFUSAL_STATUS, branchConversationAtAnswer } from "@/lib/chatConversationBranch";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";

export const dynamic = "force-dynamic";

/**
 * "Branch from this answer": a new Chat conversation holding the text turns up
 * to one answer (lib/chatConversationBranch.ts). The source is not changed and
 * nothing here calls a model or touches credits.
 *
 * The two templates are the client's own words for the new title and for the
 * note on a turn whose files were not copied; each is used only if it is short
 * plain text holding its placeholder, and the default English text otherwise.
 */
const bodySchema = z
  .object({
    messageId: z.string().min(1).max(100),
    titleTemplate: z.string().max(400).optional(),
    filesTemplate: z.string().max(400).optional(),
  })
  .strict();

export async function POST(
  req: Request,
  context: RouteContext<"/api/conversations/[conversationId]/branch">
) {
  try {
    const authentication = await resolveChatRouteSession(req);
    if (authentication.response) return authentication.response;
    const userId = authentication.session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, userId, "conversation-branch", { minute: 10, day: 200 });

    const { conversationId } = await context.params;
    if (!conversationId) {
      return NextResponse.json({ error: "Conversation ID is required." }, { status: 400 });
    }
    const body = await readLimitedJson(req, 2_048, bodySchema);
    const result = await branchConversationAtAnswer({
      userId,
      conversationId,
      messageId: body.messageId,
      titleTemplate: validBranchTemplate(body.titleTemplate, "{title}"),
      filesTemplate: validBranchTemplate(body.filesTemplate, "{names}"),
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: "This conversation cannot be branched here.", code: result.code },
        { status: BRANCH_REFUSAL_STATUS[result.code], headers: { "Cache-Control": "private, no-store" } }
      );
    }
    return NextResponse.json(
      {
        id: result.conversationId,
        title: result.title,
        surface: "chat",
        copiedMessages: result.copiedMessages,
        turnsWithOmittedFiles: result.turnsWithOmittedFiles,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to branch conversation:", error);
    return NextResponse.json({ error: "Failed to branch the conversation." }, { status: 500 });
  }
}
