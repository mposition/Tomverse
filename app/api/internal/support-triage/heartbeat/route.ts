export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";

import { handleSupportTriageHeartbeat } from "@/lib/supportTriageRoutes";

// The support-triage heartbeat, called by the team 3 watcher
// (docs/policy/support-triage.md §7). All judgement is in
// lib/supportTriageRoutes.ts; this file only answers { stale }.
export async function POST(request: Request) {
  try {
    const { status, body } = await handleSupportTriageHeartbeat(request);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const databaseCode =
      typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
    console.error(
      JSON.stringify({
        event: "support_triage_heartbeat_route_failed",
        databaseCode: databaseCode && /^[A-Z0-9]{1,10}$/.test(databaseCode) ? databaseCode : null,
      }),
    );
    return NextResponse.json({ result: "internal_error" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
