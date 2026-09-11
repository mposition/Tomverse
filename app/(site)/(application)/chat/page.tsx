export const dynamic = "force-dynamic";

import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";
import { CONVERSATION_HANDOFF_PARAM } from "@/lib/continuationRoutes";

/**
 * The compatibility path for Tomverse Review.
 *
 * Decision record v1.2 §8: `/chat` is NOT being repointed at Tomverse Chat.
 * It renders the Review workspace exactly as it did, and the canonical
 * `/review` alias renders the same shell. When `/chat` does change meaning, a
 * legacy deep link to a `productKey = "review"` conversation is moved to
 * `/review` -- which is one more reason productKey has to be settled before
 * the URL is.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The conversation a surface-crossing click handed over
  // (`conversationHandoffHref`). Read here rather than in the client so the
  // first painted frame already knows which conversation it is opening: the
  // client's own fallback is the session restore, and that is exactly the
  // path that used to reopen the continuation the user had just left.
  const params = await searchParams;
  const handoff = params[CONVERSATION_HANDOFF_PARAM];
  return (
    <ReviewWorkspaceShell
      initialConversationId={typeof handoff === "string" ? handoff : null}
    />
  );
}
