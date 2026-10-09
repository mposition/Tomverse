export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { receiveQaReleaseDigest } from "@/lib/qaReleaseDigestIntake";

// The QA-release Digest service's daily submission
// (docs/policy/qa-release-agent.md sections 1, 4 and 6). All judgement is in
// lib/qaReleaseDigestIntake.ts; this file only answers.
export async function POST(request: Request) {
  try {
    const { status, body } = await receiveQaReleaseDigest(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
