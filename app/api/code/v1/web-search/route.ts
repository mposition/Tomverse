export const dynamic = "force-dynamic";

import { handleCodeWebSearch } from "@/lib/codeWebSearch";

// The coding API's web search (docs/policy/external-api.md section 11.1): the
// agent engine's web_search tool, on the coding API's key, ledger and receipts.
// Default off (TOMVERSE_DESKTOP_WEB_SEARCH_ENABLED). Bearer-only, on the same
// condition as /api/code/v1/chat/completions (lib/requestOrigin.ts,
// tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleCodeWebSearch(request);
}
