export const dynamic = "force-dynamic";

import { prepareAnthropicMessages } from "@/lib/anthropicMessagesProtocol";
import { handleNativeFreeCall } from "@/lib/externalApiNative";
import { anthropicCountTokensPath, anthropicMessagesSpec } from "@/lib/externalApiNativeSpecs";

// Anthropic's token count on the coding API, which Claude Code uses for
// /context. Free at the provider, so no reservation or receipt; rate limited
// as a read. Bearer-only.
export async function POST(request: Request) {
    return handleNativeFreeCall(request, anthropicMessagesSpec, {
        upstreamPath: anthropicCountTokensPath(request),
        prepare: (body, model) => prepareAnthropicMessages(body, model, { countTokens: true }),
        surface: "coding",
    });
}
