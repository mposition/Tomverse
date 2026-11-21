export const dynamic = "force-dynamic";

import { handleChatCompletions } from "@/lib/externalApiInference";

// The general API (docs/policy/external-api.md): the chat registry's models.
// Bearer-only. This handler reads no cookie and no session, which is the
// condition for its exemption from the mutation Origin check in
// lib/requestOrigin.ts; tests/externalApiBoundary.test.mjs fails if it starts to.
export async function POST(request: Request) {
    return handleChatCompletions(request, { surface: "general" });
}
