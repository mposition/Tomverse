import { AssistantKnowledgeGuide } from "@/components/marketing/AssistantKnowledgeGuide";
import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Create an AI Assistant with Your Knowledge",
  description:
    "Follow three practical steps to create a private Tomverse AI assistant, add Knowledge files, and use it in a conversation.",
  path: "/guides/assistant-knowledge",
});

export default function AssistantKnowledgeGuidePage() {
  return <AssistantKnowledgeGuide />;
}
