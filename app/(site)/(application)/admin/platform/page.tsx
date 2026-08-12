export const dynamic = "force-dynamic";

import { PlatformSettingsPanel } from "@/components/admin/PlatformSettingsPanel";
import {
  getPublicAppSettings,
  isExternalImportEnabled,
  isImageGenerationEnabled,
} from "@/lib/appSettings";

export default async function AdminPlatformSettingsPage() {
  const [settings, imageGenerationEnabled, externalConversationImportEnabled] =
    await Promise.all([
      getPublicAppSettings(),
      isImageGenerationEnabled(),
      isExternalImportEnabled(),
    ]);

  return (
    <PlatformSettingsPanel
      settings={settings}
      imageGenerationEnabled={imageGenerationEnabled}
      externalConversationImportEnabled={externalConversationImportEnabled}
    />
  );
}
