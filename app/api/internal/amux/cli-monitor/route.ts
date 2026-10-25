export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { apiSecurityResponse } from "@/lib/apiSecurity";
import { recordAgentOfficeCliMonitor } from "@/lib/agentOfficeCliMonitor";

/** Telemetry only. This credential cannot register, send to or execute a worker. */
export async function POST(request: Request) {
  try {
    const result = await recordAgentOfficeCliMonitor(request);
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", "no-store"); return security; }
    return Response.json({ error: "capture_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
