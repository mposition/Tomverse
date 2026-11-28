export const dynamic = "force-dynamic";

import { handleCodeRouteOnly } from "@/lib/externalApiRouteOnly";

// The coding API's route-only choice (docs/policy/external-api.md section 5.3):
// Smart Adaptive's pick for a request and where it runs, with nothing run,
// reserved or charged. Default off (EXTERNAL_API_ROUTE_ONLY_ENABLED).
// Bearer-only, on the same condition as /api/code/v1/chat/completions
// (lib/requestOrigin.ts, tests/externalApiBoundary.test.mjs).
export async function POST(request: Request) {
    return handleCodeRouteOnly(request);
}
