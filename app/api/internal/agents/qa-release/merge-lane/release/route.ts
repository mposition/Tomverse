export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { handleQaReleaseMergeLaneRelease } from "@/lib/qaReleaseMergeLaneRoutes";

// The QA-release merge lane service's own latch release (owner decision
// 2026-11-16; docs/policy/qa-release-agent.md section 8 item 5). All judgement
// is in lib/qaReleaseMergeLaneRoutes.ts, the single writer it calls and the
// latch migration; this file only answers.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleQaReleaseMergeLaneRelease(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
