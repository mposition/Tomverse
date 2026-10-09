export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { recordReviewOrchestratorStatus } from "@/lib/reviewOrchestratorStatus";

// The independent review server's content-free status report
// (lib/reviewOrchestratorStatusCore.ts). The answer is a code, never the
// report back.
export async function POST(request: Request) {
  try {
    const { status, body } = await recordReviewOrchestratorStatus(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error(JSON.stringify({ event: "review_orchestrator_status_failed" }));
    return NextResponse.json({ result: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
