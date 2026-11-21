export const dynamic = "force-dynamic";

import { handleNativeGeneration } from "@/lib/externalApiNative";
import { responsesSpec } from "@/lib/externalApiNativeSpecs";

// OpenAI Responses on the coding API, for Codex (wire_api = "responses").
// Stateless: store is always false. Bearer-only (lib/requestOrigin.ts,
// tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleNativeGeneration(request, responsesSpec, { surface: "coding" });
}
