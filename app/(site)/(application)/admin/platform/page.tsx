export const dynamic = "force-dynamic";

import { PlatformSettingsPanel } from "@/components/admin/PlatformSettingsPanel";
import {
  getPublicAppSettings,
  isAssistantKnowledgeEnabled,
  isAssistantProfilesEnabled,
  isExternalImportEnabled,
  isImageGenerationEnabled,
} from "@/lib/appSettings";

export default async function AdminPlatformSettingsPage() {
  const [
    settings,
    imageGenerationEnabled,
    externalConversationImportEnabled,
    assistantProfilesEnabled,
    assistantKnowledgeEnabled,
  ] = await Promise.all([
    getPublicAppSettings(),
    isImageGenerationEnabled(),
    isExternalImportEnabled(),
    isAssistantProfilesEnabled(),
    isAssistantKnowledgeEnabled(),
  ]);

  return (
    <PlatformSettingsPanel
      settings={settings}
      imageGenerationEnabled={imageGenerationEnabled}
      externalConversationImportEnabled={externalConversationImportEnabled}
      assistantProfilesEnabled={assistantProfilesEnabled}
      assistantKnowledgeEnabled={assistantKnowledgeEnabled}
    />
  );
}
