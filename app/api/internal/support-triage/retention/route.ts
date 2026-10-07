export const dynamic = "force-dynamic";
export const maxDuration = 240;

import { NextResponse } from "next/server";

import { handleSupportTriageRetention } from "@/lib/supportTriageRoutes";

// One retention run, called by the Support Triage Retention cron service
// (docs/policy/support-triage.md §3, §5). All judgement is in
// lib/supportTriageRoutes.ts; this file only answers, with counts and never
// a report, an id or a secret.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleSupportTriageRetention(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const databaseCode =
      typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
    console.error(
      JSON.stringify({
        event: "support_triage_retention_route_failed",
        databaseCode: databaseCode && /^[A-Z0-9]{1,10}$/.test(databaseCode) ? databaseCode : null,
      }),
    );
    return NextResponse.json({ result: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
