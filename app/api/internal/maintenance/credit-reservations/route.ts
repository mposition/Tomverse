import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import { reconcileExpiredChatRequestLeases } from "@/lib/chatRequestLease";
import { reconcileExpiredExternalImportStaging } from "@/lib/externalImportService";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";
import { monitorInfrastructureThresholdsIfDue } from "@/lib/infrastructureThresholdMonitor";
import { drainNotificationDeliveriesQuietly } from "@/lib/notificationDeliveryJob";
import { reconcileProcessingRefundRequestsQuietly } from "@/lib/refundReconciliation";
import { runImageAssetMaintenanceQuietly } from "@/lib/imageAssetLifecycle";

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
  const run = await startScheduledJob("credit_reservation_reconciliation");
  try {
    const result = await reconcileExpiredChatCreditReservations(
      new Date(),
      1_000
    );
    const infrastructureMonitor = await monitorInfrastructureThresholdsIfDue();
    // Rides along on the only fifteen-minute schedule this deployment already
    // has, so the operator-notification queue drains without a second cron
    // entry having to be provisioned. It never throws, so it cannot turn a
    // successful reconciliation into a failed one.
    const notificationDeliveries = await drainNotificationDeliveriesQuietly();
    // Rides along for the same reason, and matters more: a refund stuck in
    // `processing` means money may have left the account with nothing
    // recording it. It never throws, so it cannot turn a successful
    // reconciliation into a failed one.
    const refundRequests = await reconcileProcessingRefundRequestsQuietly();
    // Concurrency leases orphaned by a killed worker or a failed release are
    // swept on this fifteen-minute cadence rather than the daily cleanup: an
    // orphan holds a slot a real person is waiting on, so a day of it is a day
    // of unexplained "a response is already being generated".
    const requestLeases = await reconcileExpiredChatRequestLeases().catch(
      () => ({ removed: 0 })
    );
    // Rides along like the queues above: drains the DB-first image asset
    // deletion tombstones against R2 and audits the image invariants (an
    // image conversation with no generation, a generation whose worker
    // died). It never throws, so it cannot turn a successful reconciliation
    // into a failed one.
    const imageAssets = await runImageAssetMaintenanceQuietly();
    // Staged external-import payloads carry user conversation content and a
    // 24h-idle / 72h-absolute lifetime (policy §5.5). The lazy checks in
    // batch/finalize are the primary guard; this sweep clears content whose
    // owner never came back. Never throws, so it cannot turn a successful
    // reconciliation into a failed one.
    const externalImportStaging =
      await reconcileExpiredExternalImportStaging().catch(() => ({
        expiredImports: 0,
      }));
    await completeScheduledJob({
      runId: run?.id,
      processedCount: result.examined,
      result: {
        ...result,
        infrastructureMonitor,
        notificationDeliveries,
        refundRequests,
        requestLeases,
        imageAssets,
        externalImportStaging,
      },
    });
    return Response.json(
      {
        success: true,
        result,
        infrastructureMonitor,
        notificationDeliveries,
        refundRequests,
        requestLeases,
        imageAssets,
        externalImportStaging,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    after(() =>
      reportOperationalIncident({
        code: "CREDIT_RESERVATION_RECONCILIATION_FAILED",
        title: "Credit reservation reconciliation failed",
        error,
        severity: "fatal",
        cooldownMs: 15 * 60 * 1_000,
        context: {
          component: "maintenance-credit-reservations",
          route: "/api/internal/maintenance/credit-reservations",
        },
      })
    );
    return Response.json(
      { error: "Credit reservation reconciliation failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
