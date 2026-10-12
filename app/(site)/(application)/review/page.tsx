export const dynamic = "force-dynamic";

import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";
import { CONVERSATION_HANDOFF_PARAM } from "@/lib/continuationRoutes";

/**
 * `/review` — the canonical Tomverse Review URL.
 *
 * Decision record v1.2 §7 (합류) and §8. The same shell as `/chat`, not a copy:
 * a second implementation would drift, and the parity job would end up
 * comparing two implementations rather than two URLs.
 *
 * The product selector and stored-product handoff both navigate here. The
 * layout remains `noindex` exactly as `/chat` is; route visibility and search
 * indexing are separate decisions.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Same handoff `/chat` reads, for the same reason: the stored product owns
  // the conversation, so this canonical Review route must honour its id.
  const params = await searchParams;
  const handoff = params[CONVERSATION_HANDOFF_PARAM];
  return (
    <ReviewWorkspaceShell
      initialConversationId={typeof handoff === "string" ? handoff : null}
    />
  );
}
