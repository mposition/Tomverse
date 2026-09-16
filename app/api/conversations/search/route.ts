export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { searchConversationMessages } from "@/lib/conversationSearch";
import {
  DISPLAY_TIME_ZONE_HEADER,
  effectiveDisplayTimeZone,
} from "@/lib/continuationTitleContext";

/**
 * Message search, native and imported.
 *
 * docs/policy/external-conversation-continuation.md §8.2: a search hit is a
 * way into a conversation too, so every hit says where that conversation
 * opens (`surface`, decided by `conversationSurface()`), and names it with the
 * same naming columns the list reads (lib/continuationTitleContext.ts) --
 * otherwise an unnamed continuation's hit showed the writer's internal
 * placeholder. The query, authorisation and ranking live in
 * lib/conversationSearch.ts.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "conversation-search", {
      minute: 30,
      day: 1_000,
    });

    const q = new URL(req.url).searchParams.get("q")?.trim() || "";
    if (q.length < 2) {
      return NextResponse.json({ results: [], truncated: false, sourceSearch: "ok", validUntil: null });
    }
    if (q.length > 80) {
      return NextResponse.json({ error: "Search query is too long." }, { status: 400 });
    }

    const answer = await searchConversationMessages({
      request: req,
      userId: session.user.id,
      query: q,
      // Formatting only (lib/continuationTitleContext.ts).
      displayTimeZone: effectiveDisplayTimeZone(req.headers.get(DISPLAY_TIME_ZONE_HEADER)),
    });

    return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Conversation search failed:", error);
    return NextResponse.json({ error: "Search failed." }, { status: 500 });
  }
}
