import "server-only";
import type { Session } from "next-auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { agentOfficeCliMonitorCredential } from "@/lib/agentOfficeCliMonitor";
import { agentOfficeCliBuffer } from "@/lib/agentOfficeCliMonitorBuffer";
import { AGENT_OFFICE_CLI_WORKER } from "@/lib/agentOfficeCliMonitorCore";

export const agentOfficeCliJson = (body: object, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" },
});

/** The session is obtained by the route, never from the request body. */
export async function readAgentOfficeCliMonitor(request: Request, session: Session | null,
  rateLimit = consumeApiRateLimit) {
  try {
    if (!session?.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner")
      return agentOfficeCliJson({ error: "not_found" }, 404);
    await assertRecentAdminAuthentication(session);
    await rateLimit(request, session.user.id, "admin-office-cli-monitor", { minute: 120, day: 20_000 });
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== "worker") || query.getAll("worker").length !== 1 ||
        query.get("worker") !== AGENT_OFFICE_CLI_WORKER) return agentOfficeCliJson({ error: "invalid_request" }, 400);
    const credential = agentOfficeCliMonitorCredential();
    return agentOfficeCliJson(credential ? agentOfficeCliBuffer.read(credential) :
      { state: "unavailable", receivedAt: null, snapshot: null });
  } catch (error) {
    if (isAdminReauthenticationError(error)) return agentOfficeCliJson({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }, 428);
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", "private, no-store, max-age=0"); return security; }
    return agentOfficeCliJson({ error: "cli_monitor_unavailable" }, 503);
  }
}
