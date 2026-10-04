export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { handleQaReleaseMergeConsume } from "@/lib/qaReleaseMergeLaneRoutes";

// The QA-release merge lane service's instruction consume (docs/policy/qa-release-agent.md
// version 4, sections 3 and 10). All judgement is in lib/qaReleaseMergeLaneRoutes.ts
// and the single writer it calls; this file only answers.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleQaReleaseMergeConsume(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
