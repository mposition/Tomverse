import "server-only";

import { listImageModels } from "@/lib/imageModelRegistry";

// Main uses the same static catalogue for routing and image generation until
// the separate dynamic-catalogue release supplies its database-backed reader.
export const refreshImageModelCatalog = async () => listImageModels();
