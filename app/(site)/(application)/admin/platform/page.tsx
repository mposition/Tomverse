export const dynamic = "force-dynamic";

import { PlatformSettingsPanel } from "@/components/admin/PlatformSettingsPanel";
import {
  getMemoryExtractionRevokedPairs,
  getPublicAppSettings,
  isAssistantKnowledgeEnabled,
  isAssistantPackageImportEnabled,
  isAssistantProfilesEnabled,
  isChatStarterEnabled,
  isExternalContinuationEnabled,
  isExternalImportEnabled,
  isImageGenerationEnabled,
  isMemoryExtractionEnabled,
  isMemoryInjectionEnabled,
} from "@/lib/appSettings";
import { injectableExtractionPairs } from "@/lib/memoryInjectionGate";
import { readGuestLeadFacts } from "@/lib/guestLeadFacts";

export default async function AdminPlatformSettingsPage() {
  const [
    settings,
    imageGenerationEnabled,
    externalConversationImportEnabled,
    externalConversationContinuationEnabled,
    assistantProfilesEnabled,
    assistantKnowledgeEnabled,
    chatStarterEnabled,
    assistantPackageImportEnabled,
    memoryExtractionEnabled,
    memoryInjectionEnabled,
    revokedPairs,
    guestLead,
  ] = await Promise.all([
    getPublicAppSettings(),
    isImageGenerationEnabled(),
    isExternalImportEnabled(),
    isExternalContinuationEnabled(),
    isAssistantProfilesEnabled(),
    isAssistantKnowledgeEnabled(),
    isChatStarterEnabled(),
    // Reported here, changed through its own control and its own request: a
    // save that carried it with everything else could not leave an audit row
    // saying this flag moved
    // (`docs/policy/assistant-package-import.md` §12.2.1).
    isAssistantPackageImportEnabled(),
    // Read, never written from this screen: the two Release B flags are the
    // policy §12.4 human procedure and the panel reports them without offering
    // to change them. See the PATCH schema in /api/admin/app-settings.
    isMemoryExtractionEnabled(),
    isMemoryInjectionEnabled(),
    getMemoryExtractionRevokedPairs(),
    readGuestLeadFacts(),
  ]);

  return (
    <PlatformSettingsPanel
      settings={settings}
      imageGenerationEnabled={imageGenerationEnabled}
      externalConversationImportEnabled={externalConversationImportEnabled}
      externalConversationContinuationEnabled={
        externalConversationContinuationEnabled
      }
      assistantProfilesEnabled={assistantProfilesEnabled}
      assistantKnowledgeEnabled={assistantKnowledgeEnabled}
      chatStarterEnabled={chatStarterEnabled}
      assistantPackageImportEnabled={assistantPackageImportEnabled}
      memoryExtractionEnabled={memoryExtractionEnabled}
      memoryInjectionEnabled={memoryInjectionEnabled}
      memoryApprovedPairCount={injectableExtractionPairs(revokedPairs).length}
      storedGuestDefaultModelId={guestLead.stored}
    />
  );
}
