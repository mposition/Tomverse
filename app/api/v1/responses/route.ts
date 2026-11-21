export const dynamic = "force-dynamic";

import { handleNativeGeneration } from "@/lib/externalApiNative";
import { responsesSpec } from "@/lib/externalApiNativeSpecs";

// OpenAI Responses on the general API. Stateless: store is always false.
// Bearer-only, like /api/v1/chat/completions (lib/requestOrigin.ts,
// tests/externalApiBoundary.test.mjs). Codex uses the coding API's
// /api/code/v1/responses.
export async function POST(request: Request) {
    return handleNativeGeneration(request, responsesSpec, { surface: "general" });
}
