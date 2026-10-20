export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { claimNextRecommendation } from "@/lib/autoRouterRecAgent";
import { isAutoRouterRecAgentAuthorized } from "@/lib/autoRouterRecAgentCore";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The coding agent on the Ubuntu runner takes the oldest open code
 * recommendation (lib/autoRouterRecAgent.ts). 204 when the owner's switch is
 * off or nothing is open; a wrong or missing secret is 404, like a route that
 * is not there.
 */
export async function POST(request: Request) {
  if (!isAutoRouterRecAgentAuthorized(request.headers.get("authorization"), process.env)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  }
  try {
    const claimed = await claimNextRecommendation({ origin: new URL(request.url).origin });
    if (!claimed) return new NextResponse(null, { status: 204, headers: NO_STORE });
    return NextResponse.json(claimed, { headers: NO_STORE });
  } catch {
    console.error(JSON.stringify({ event: "auto_router_rec_agent_claim_failed" }));
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}
