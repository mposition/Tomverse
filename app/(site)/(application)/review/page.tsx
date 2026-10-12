export const dynamic = "force-dynamic";

import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";
import { CONVERSATION_HANDOFF_PARAM } from "@/lib/continuationRoutes";

/**
 * `/review` — the canonical Tomverse Review URL used by the product selector,
 * stored-product handoffs and public product links.
 *
 * Decision record v1.2 §7 (합류) and §8. The same shell as `/chat`, not a copy:
 * a second implementation would drift, and the parity job would end up
 * comparing two implementations rather than two URLs.
 *
 * The workspace remains `noindex` like `/chat`; public product information
 * lives at `/products/review`. Prepared links preserve model and prompt
 * parameters and leave the user in control of sending the question.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Same handoff `/chat` reads, for the same reason: the stored product owns
  // the conversation, so this canonical Review route must honour its id no
  // matter whether navigation began in the selector or a prepared link.
  const params = await searchParams;
  const handoff = params[CONVERSATION_HANDOFF_PARAM];
  return (
    <ReviewWorkspaceShell
      initialConversationId={typeof handoff === "string" ? handoff : null}
    />
  );
}
