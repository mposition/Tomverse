export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { handleQaReleaseLaneRound } from "@/lib/qaReleaseMergeLaneRoundStore";

// What the QA-release merge lane saw on its latest round, for Admin › QA and
// release. Display only; all judgement is in lib/qaReleaseMergeLaneRoundStore.ts.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleQaReleaseLaneRound(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
