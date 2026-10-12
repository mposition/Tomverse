import { ChatWorkspaceShell } from "@/components/chat/ChatWorkspaceShell";

export const dynamic = "force-dynamic";

/** Compatibility alias; new product navigation uses canonical `/chat`. */
export default async function ChatWorkspacePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ChatWorkspaceShell searchParams={await searchParams} />;
}
