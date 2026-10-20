export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseRecommendationId, recordRecommendationResult } from "@/lib/autoRouterRecAgent";
import { isAutoRouterRecAgentAuthorized } from "@/lib/autoRouterRecAgentCore";
import {
  admitRecommendationPrUrl,
  RECOMMENDATION_FAILURE_REASONS,
} from "@/lib/autoRouterRecommendationsCore";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";

const NO_STORE = { "Cache-Control": "no-store" };

const bodySchema = z.discriminatedUnion("outcome", [
  z.object({ id: z.string().max(80), claimId: z.string().uuid(), outcome: z.literal("pr_opened"), prUrl: z.string().max(200) }).strict(),
  z.object({ id: z.string().max(80), claimId: z.string().uuid(), outcome: z.literal("failed"), reason: z.enum(RECOMMENDATION_FAILURE_REASONS) }).strict(),
]);

/**
 * The coding agent reports what came of a claim: the develop PR it opened, or
 * a reason code from a closed list. Only a claimed recommendation takes a
 * result; the same result again is a replay (lib/autoRouterRecAgent.ts).
 */
export async function POST(request: Request) {
  if (!isAutoRouterRecAgentAuthorized(request.headers.get("authorization"), process.env)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  }
  try {
    const body = await readLimitedJson(request, 1024, bodySchema);
    const id = parseRecommendationId(body.id);
    if (!id) return NextResponse.json({ error: "bad_id" }, { status: 400, headers: NO_STORE });
    let result: Parameters<typeof recordRecommendationResult>[0]["result"];
    if (body.outcome === "pr_opened") {
      const prUrl = admitRecommendationPrUrl(body.prUrl);
      if (!prUrl) return NextResponse.json({ error: "bad_pr_url" }, { status: 400, headers: NO_STORE });
      result = { claimId: body.claimId, outcome: "pr_opened", prUrl };
    } else {
      result = { claimId: body.claimId, outcome: "failed", reason: body.reason };
    }
    const outcome = await recordRecommendationResult({ ...id, result });
    if ("refused" in outcome) {
      return NextResponse.json({ error: outcome.refused }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true, changed: outcome.changed }, { headers: NO_STORE });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error(JSON.stringify({ event: "auto_router_rec_agent_result_failed" }));
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}
