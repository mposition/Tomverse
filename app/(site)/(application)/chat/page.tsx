export const dynamic = "force-dynamic";

import { ChatWorkspaceShell } from "@/components/chat/ChatWorkspaceShell";

/**
 * Canonical Tomverse Chat entry.
 *
 * The server shell decides from the owned stored row whether a conversation
 * belongs to Chat, Review or Continuations before the client renders. It never
 * rewrites productKey from the URL.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ChatWorkspaceShell searchParams={await searchParams} />;
}
