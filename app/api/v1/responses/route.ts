export const dynamic = "force-dynamic";

import { handleNativeGeneration } from "@/lib/externalApiNative";
import { responsesSpec } from "@/lib/externalApiNativeSpecs";

// OpenAI Responses for Codex (wire_api = "responses"). Stateless: store is
// always false. Bearer-only, like /api/v1/chat/completions (lib/requestOrigin.ts,
// tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleNativeGeneration(request, responsesSpec);
}
