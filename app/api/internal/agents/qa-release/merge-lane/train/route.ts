export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { handleQaReleaseTrain } from "@/lib/qaReleaseTrainRoutes";

// The QA-release release train's admission and report (docs/policy/qa-release-agent.md
// section 8 item 12). All judgement is in lib/qaReleaseTrainRoutes.ts and the
// store it calls; this file only answers.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleQaReleaseTrain(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
