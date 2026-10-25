export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { agentOfficeCliJson, readAgentOfficeCliMonitor } from "@/lib/agentOfficeCliMonitorRead";

/** No stdin, session send, command, execution or mutation endpoint exists here. */
export async function GET(request: Request) {
  try {
    return await readAgentOfficeCliMonitor(request, await getServerSession(authOptions));
  } catch {
    return agentOfficeCliJson({ error: "cli_monitor_unavailable" }, 503);
  }
}
