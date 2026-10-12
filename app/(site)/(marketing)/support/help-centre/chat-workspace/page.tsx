import { ChatWorkspaceGuide } from "@/components/marketing/ChatWorkspaceGuide";
import { publicMarketingPageMetadata } from "@/lib/publicMarketingMetadata";

export const metadata = publicMarketingPageMetadata("/support/help-centre/chat-workspace");

export default function ChatWorkspaceGuidePage() {
  return <ChatWorkspaceGuide />;
}
