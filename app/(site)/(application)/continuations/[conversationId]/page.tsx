export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { getServerSession } from "next-auth/next";

import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";
import { authOptions } from "@/lib/auth";
import { isE2EFixtureMode } from "@/lib/e2eTestMode";
import { prisma } from "@/lib/prisma";

/**
 * `/continuations/[conversationId]` — a conversation continued from an
 * imported chat, in the ordinary Tomverse workspace.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.2, and
 * `lib/continuationRoutes.ts` for why this is its own path.
 *
 * ## What this route stopped being
 *
 * It used to render a screen of its own: a textarea, a grid of model buttons,
 * its own message list, no sidebar. Everything below the divider was a second
 * implementation of the chat surface, and the ways it differed were not
 * decisions — no attachments, no web search, no stop, no retry, no IME
 * handling anyone had checked, and no way back into the conversation from the
 * sidebar. What is genuinely particular to a continuation is one thing: the
 * transcript it was started from. So that is the only thing this route adds,
 * and the workspace under it is the same component `/chat` and `/review`
 * render.
 *
 * The path stays because the imported half has to be part of the URL's
 * meaning: `conversationSurface()` sends a bridged conversation here from the
 * sidebar and from search, and it reads the bridge — never the product key.
 *
 * ## Which workspace
 *
 * The stored product of the owned row: a Chat continuation renders the Chat
 * workspace (Smart Adaptive), anything else the Review workspace. Before
 * 2026-10-25 this mount was neither, and showed the legacy comparison screen.
 * The key remounts the client when the product changes under the same route,
 * which is what following "Compare in Review" from a Chat continuation does.
 *
 * Nothing is gated here. The rollout flag governs *creating* a continuation
 * and *seeding* a turn from one; opening a conversation that already exists,
 * and the messages the owner wrote in it, are never behind it — a rollback
 * must not take away work somebody already did (§7).
 */
export default async function ContinuedConversationPage({
    params,
}: {
    params: Promise<{ conversationId: string }>;
}) {
    const { conversationId } = await params;
    const continuationProduct = await storedContinuationProduct(conversationId);
    return (
        <ReviewWorkspaceShell
            key={continuationProduct}
            initialConversationId={conversationId}
            mountedSurface="continuation"
            continuationProduct={continuationProduct}
        />
    );
}

/** Review for anything unreadable: it is what every continuation was before. */
async function storedContinuationProduct(
    conversationId: string
): Promise<"chat" | "review"> {
    // Browser-only mocked journeys have no database, so a spec names its Chat
    // continuations (comma-separated ids) in a cookie, behind the same loopback
    // + two-flag fixture boundary as the other shells. Never read on a
    // deployment.
    if (isE2EFixtureMode()) {
        const jar = await cookies();
        const chatIds = jar.get("__tomverse_e2e_chat_continuations")?.value ?? "";
        return chatIds.split(",").includes(conversationId) ? "chat" : "review";
    }
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) return "review";
        const row = await prisma.conversation.findFirst({
            where: { id: conversationId, userId },
            select: { productKey: true },
        });
        return row?.productKey === "chat" ? "chat" : "review";
    } catch {
        return "review";
    }
}
