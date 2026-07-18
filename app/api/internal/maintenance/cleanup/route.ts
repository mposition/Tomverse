import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { cleanupExpiredData } from "@/lib/maintenance";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

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
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const run = await startScheduledJob("retention_cleanup");
  try {
    const deleted = await cleanupExpiredData();
    const processedCount = Object.values(deleted).reduce<number>(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0
    );
    await completeScheduledJob({
      runId: run?.id,
      processedCount,
      result: JSON.parse(JSON.stringify(deleted)),
    });
    return Response.json(
      { success: true, deleted },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    after(() =>
      reportOperationalIncident({
        code: "SCHEDULED_MAINTENANCE_CLEANUP_FAILED",
        title: "Scheduled maintenance cleanup failed",
        error,
        severity: "error",
        cooldownMs: 60 * 60 * 1_000,
        context: {
          component: "maintenance-cleanup",
          route: "/api/internal/maintenance/cleanup",
        },
      })
    );
    return Response.json(
      { error: "Maintenance cleanup failed." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
