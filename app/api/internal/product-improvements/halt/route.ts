export const dynamic = "force-dynamic";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { isAutoRouterRecAgentAuthorized } from "@/lib/autoRouterRecAgentCore";
import { DAILY_PRODUCT_AGENT_ALERT_SWITCH, dailyProductHaltSchema } from "@/lib/dailyProductAgentAlertCore";
import { DAILY_PRODUCT_AGENT_HEADER, DAILY_PRODUCT_AGENT_MODE } from "@/lib/dailyProductAgentCore";
import { recordDailyProductHalt } from "@/lib/dailyProductAgentStore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  if (!isAutoRouterRecAgentAuthorized(request.headers.get("authorization"), process.env) ||
      request.headers.get(DAILY_PRODUCT_AGENT_HEADER) !== DAILY_PRODUCT_AGENT_MODE ||
      process.env[DAILY_PRODUCT_AGENT_ALERT_SWITCH] !== "true") {
    return Response.json({ error: "Not found." }, { status: 404, headers });
  }
  try {
    const input = await readLimitedJson(request, 1024, dailyProductHaltSchema);
    const result = await recordDailyProductHalt(input);
    if ("refused" in result) return Response.json({ error: result.refused }, { status: 409, headers });
    if (result.changed) {
      const origin = (process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://tomverse.app").replace(/\/+$/u, "");
      await reportOperationalIncident({
        code: "DAILY_PRODUCT_AGENT_STOPPED", title: "Daily product agent stopped", severity: "error",
        forceNotification: true,
        context: { component: "daily-product-agent", runId: input.runId, reason: input.reason,
          attempted: input.attempted, prOpened: input.prOpened, lastConfirmedPr: input.lastPrUrl,
          admin: `${origin}/admin/alerts?tab=deliveries` },
      }).catch(() => console.error(JSON.stringify({ event: "daily_product_halt_external_alert_failed" })));
    }
    return Response.json({ recorded: true, changed: result.changed }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error(JSON.stringify({ event: "daily_product_halt_notice_failed" }));
    return Response.json({ error: "internal_error" }, { status: 500, headers });
  }
}
