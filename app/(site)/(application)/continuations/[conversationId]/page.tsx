export const dynamic = "force-dynamic";

import { ContinuedConversationWorkspace } from "@/components/continuations/ContinuedConversationWorkspace";

/**
 * `/continuations/[conversationId]` — where a conversation continued from an
 * imported chat is read and continued.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8, and
 * `lib/continuationRoutes.ts` for why this is its own path rather than `/chat`.
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
        <main>
            <ContinuedConversationWorkspace conversationId={conversationId} />
        </main>
    );
}
