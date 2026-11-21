export const dynamic = "force-dynamic";

import { handleChatCompletions } from "@/lib/externalApiInference";

// The coding API (docs/policy/external-api.md): Cursor and the tomverse CLI.
// The coding catalogue's models while CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED
// is on, the general API's otherwise. Bearer-only, on the same condition as
// /api/v1/chat/completions (lib/requestOrigin.ts, tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleChatCompletions(request, { surface: "coding" });
}
