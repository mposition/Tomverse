export const dynamic = "force-dynamic";

import { handleNativeGeneration } from "@/lib/externalApiNative";
import { anthropicMessagesSpec } from "@/lib/externalApiNativeSpecs";

// Anthropic Messages on the general API. Claude Code uses the coding API's
// /api/code/anthropic. Bearer-only, like /api/v1/chat/completions: reads no
// cookie or session, which is the condition for its Origin-check exemption
// (lib/requestOrigin.ts, tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleNativeGeneration(request, anthropicMessagesSpec, { surface: "general" });
}
