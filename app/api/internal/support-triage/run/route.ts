export const dynamic = "force-dynamic";
export const maxDuration = 540;

import { NextResponse } from "next/server";

import { handleSupportTriageRun } from "@/lib/supportTriageRoutes";

// One worker pass, called by the Support Triage cron service
// (docs/policy/support-triage.md §3). All judgement is in
// lib/supportTriageRoutes.ts; this file only answers, with counts and never
// a report, an id or a secret.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleSupportTriageRun(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const databaseCode =
      typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
    console.error(
      JSON.stringify({
        event: "support_triage_run_route_failed",
        databaseCode: databaseCode && /^[A-Z0-9]{1,10}$/.test(databaseCode) ? databaseCode : null,
      }),
    );
    return NextResponse.json({ result: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
