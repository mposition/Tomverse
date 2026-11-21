export const dynamic = "force-dynamic";

import { handleNativeGeneration } from "@/lib/externalApiNative";
import { anthropicMessagesSpec } from "@/lib/externalApiNativeSpecs";

// Claude Code's Anthropic Messages endpoint on the coding API
// (ANTHROPIC_BASE_URL=.../api/code/anthropic). Bearer-only: reads no cookie or
// session, the condition for its Origin-check exemption (lib/requestOrigin.ts,
// tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleNativeGeneration(request, anthropicMessagesSpec, { surface: "coding" });
}
