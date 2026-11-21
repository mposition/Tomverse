export const dynamic = "force-dynamic";

import { handleOpenAiModelList } from "@/lib/externalApiModelRoutes";

// The coding API's model list (lib/externalApiCatalog.ts, surface "coding").
export async function GET(request: Request) {
    return handleOpenAiModelList(request, "coding");
}
