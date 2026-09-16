import { AssistantKnowledgeGuide } from "@/components/marketing/AssistantKnowledgeGuide";
import {
  isAssistantPackageImportEnabled,
} from "@/lib/appSettings";
import {
  configuredAssistantKnowledgeSupademoEmbeds,
} from "@/lib/assistantKnowledgeSupademo";
import { createPageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata = createPageMetadata({
  title: "Create an AI Assistant with Your Knowledge",
  description:
    "Follow three practical steps to create a private Tomverse AI assistant, add Knowledge files, and use it in a conversation.",
  path: "/guides/assistant-knowledge",
});

async function packageImportAvailableForGuide() {
  try {
    return await isAssistantPackageImportEnabled();
  } catch (error) {
    console.warn("Assistant Knowledge guide package flag read failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }
}

export default async function AssistantKnowledgeGuidePage() {
  const packageImportAvailable = await packageImportAvailableForGuide();

  return (
    <AssistantKnowledgeGuide
      packageImportAvailable={packageImportAvailable}
      supademoEmbeds={configuredAssistantKnowledgeSupademoEmbeds()}
    />
  );
}
