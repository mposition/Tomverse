import { ChatWorkspaceShell } from "@/components/chat/ChatWorkspaceShell";

export const dynamic = "force-dynamic";

export default async function ChatWorkspacePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ChatWorkspaceShell searchParams={await searchParams} />;
}
