export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { runQaReleaseMonitor } from "@/lib/qaReleaseMonitor";

// The QA-release Monitor service's silence check
// (docs/policy/qa-release-agent.md sections 3, 6 and 7). All judgement is in
// lib/qaReleaseMonitor.ts; this file only answers.
export async function POST(request: Request) {
  try {
    const { status, body } = await runQaReleaseMonitor(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
