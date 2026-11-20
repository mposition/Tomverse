export const dynamic = "force-dynamic";

import { POST as claim } from "@/app/api/internal/auto-router/recommendations/claim/route";
import { DAILY_PRODUCT_AGENT_HEADER, DAILY_PRODUCT_AGENT_MODE } from "@/lib/dailyProductAgentCore";

/** Dedicated version boundary: older deployed apps cannot claim a legacy task here. */
export async function POST(request: Request) {
  if (request.headers.get(DAILY_PRODUCT_AGENT_HEADER) !== DAILY_PRODUCT_AGENT_MODE) {
    return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return claim(request);
}
