export const dynamic = "force-dynamic";

import { handleAnthropicModelList } from "@/lib/externalApiModelRoutes";

// Anthropic-shaped model discovery on the general API: the chat registry's
// models this key can run natively. Same plan and credential filter as
// /api/v1/models.
export async function GET(request: Request) {
    return handleAnthropicModelList(request, "general");
}
