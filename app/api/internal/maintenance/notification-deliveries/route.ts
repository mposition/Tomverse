import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { runNotificationDeliveryDrain } from "@/lib/notificationDeliveryJob";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

/**
 * Drains the operator-notification retry queue on demand.
 *
 * The queue also drains from the five-minute credit reconciliation cron, so
 * this endpoint is not the only thing keeping it moving -- it exists so an
 * operator can force a pass right after fixing a mail configuration instead of
 * waiting for the next tick.
 */
const isAuthorized = (request: Request) => {
  const configured = process.env.MAINTENANCE_SECRET;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!configured || configured.length < 32 || !provided) return false;
  const expectedDigest = createHash("sha256").update(configured).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const result = await runNotificationDeliveryDrain();
    return Response.json(
      { success: true, result },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    after(() =>
      reportOperationalIncident({
        code: "NOTIFICATION_DELIVERY_DRAIN_FAILED",
        title: "Operator notification retry drain failed",
        error,
        severity: "error",
        cooldownMs: 30 * 60 * 1_000,
        context: {
          component: "maintenance-notification-deliveries",
          route: "/api/internal/maintenance/notification-deliveries",
        },
      })
    );
    return Response.json(
      { error: "Notification delivery drain failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
