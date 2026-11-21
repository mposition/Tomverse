export const dynamic = "force-dynamic";

import { handleAnthropicModelList } from "@/lib/externalApiModelRoutes";

// Claude Code's model discovery on the coding API, in Anthropic's list shape.
export async function GET(request: Request) {
    return handleAnthropicModelList(request, "coding");
}
