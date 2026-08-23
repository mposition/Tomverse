export const dynamic = "force-dynamic";

import { ReviewWorkspaceShell } from "@/components/chat/ReviewWorkspaceShell";

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
export default function ChatPage() {
  return <ReviewWorkspaceShell />;
}
