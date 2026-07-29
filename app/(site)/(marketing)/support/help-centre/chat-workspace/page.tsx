import { ChatWorkspaceGuide } from "@/components/marketing/ChatWorkspaceGuide";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Chat Workspace Guide",
  description:
    "Learn how to use Tomverse conversations, projects, personal labels, locks, sharing, model panels, AI Review, files, and credits.",
  path: "/support/help-centre/chat-workspace",
});

export default function ChatWorkspaceGuidePage() {
  return <ChatWorkspaceGuide />;
}
