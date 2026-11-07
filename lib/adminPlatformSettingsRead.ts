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

/**
 * Everything `PlatformSettingsPanel` is given, read once for whichever page
 * draws part of it: Feature flags (`/admin/platform`) and the Default models
 * tab of Models. The panel holds one state for all of it, so both mounts take
 * the same reads.
 */
export async function readPlatformSettingsPanelProps() {
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

  return {
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
    memoryApprovedPairCount: injectableExtractionPairs(revokedPairs).length,
    storedGuestDefaultModelId: guestLead.stored,
  };
}
