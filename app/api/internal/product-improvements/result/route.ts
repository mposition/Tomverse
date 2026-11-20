export const dynamic = "force-dynamic";

import { POST as result } from "@/app/api/internal/auto-router/recommendations/result/route";
import { DAILY_PRODUCT_AGENT_HEADER, DAILY_PRODUCT_AGENT_MODE } from "@/lib/dailyProductAgentCore";

export async function POST(request: Request) {
  if (request.headers.get(DAILY_PRODUCT_AGENT_HEADER) !== DAILY_PRODUCT_AGENT_MODE) {
    return Response.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return result(request);
}
