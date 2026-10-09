export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { handleQaReleaseMergeLaneState } from "@/lib/qaReleaseMergeLaneRoutes";

// The QA-release merge lane service's state read at the start of a round
// (docs/policy/qa-release-agent.md version 4, section 8 item 5). All of it is
// in lib/qaReleaseMergeLaneRoutes.ts; this file only answers.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleQaReleaseMergeLaneState(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
