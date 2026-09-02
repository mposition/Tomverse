export const dynamic = "force-dynamic";

import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";
import { ContinuationSourcePrelude } from "@/components/continuations/ContinuationSourcePrelude";

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
 * sidebar and from search, and it reads the bridge — never the product key,
 * which is `review` and shared with every other Review conversation.
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
    return (
        <ReviewWorkspaceShell
            initialConversationId={conversationId}
            mountedSurface="continuation"
            conversationPrelude={
                <ContinuationSourcePrelude conversationId={conversationId} />
            }
        />
    );
}
