import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import { reconcileExpiredChatRequestLeases } from "@/lib/chatRequestLease";
import { reconcileExpiredExternalImportStaging } from "@/lib/externalImportService";
import { dispatchPendingMemoryExtractionRunsQuietly } from "@/lib/memoryExtractionDispatch";
import { backfillMemorySearchTerms } from "@/lib/memoryRetrieval";
import { reconcileLockedSourceMemoriesSweep } from "@/lib/externalConversationLock";
import { reconcileStrandedMemories } from "@/lib/memorySourceDelete";
import { reconcileExpiredMemoryExtractionRuns } from "@/lib/memoryExtractionService";
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
    // Memory extraction leases (policy §3): a running run whose heartbeat
    // stopped goes back to pending, progress intact, so the owner can resume
    // instead of being blocked by their own orphan. Never throws.
    const memoryExtractionLeases =
      await reconcileExpiredMemoryExtractionRuns().catch(() => ({
        reclaimedRuns: 0,
      }));
    // Reclaiming only makes an orphaned run claimable again — something has to
    // claim it. This is the durable driver (policy §11): the post-response
    // kick is a latency optimisation that dies with its request, so a run
    // finishes because this runs, not because a kick did. Deliberately after
    // the sweep, so runs it just parked are dispatched in the same tick.
    const memoryExtractionDispatch =
      await dispatchPendingMemoryExtractionRunsQuietly();
    // Retrieval v1 (policy §9) indexes at write, so this only ever has work
    // for rows that predate it. Bounded per tick and self-terminating: once
    // `remaining` reaches zero it stays there. Never throws.
    const memorySearchTermsBackfill = await backfillMemorySearchTerms().catch(
      () => ({ updated: 0, remaining: 0 })
    );
    // §13.1 reconciliation: an active memory with no evidence left cannot
    // exist under §8.4, and retrieval would keep serving it. A partial
    // failure, an account cascade or a delete path nobody wired up all leave
    // that same footprint. Suspends rather than deletes — the strand happened
    // by accident, and destroying data on the strength of a bug is worse.
    const strandedMemories = await reconcileStrandedMemories().catch(() => ({
      suspended: 0,
    }));
    // §7.1 reconciliation, and it fails in both directions: an unsuspended
    // memory keeps quoting a locked source, and one suspended for a source
    // that is no longer locked stays silently unavailable. Only accounts that
    // could have diverged are touched. Never throws.
    const lockedSourceMemories = await reconcileLockedSourceMemoriesSweep().catch(
      () => ({ accounts: 0, suspended: 0, restored: 0 })
    );
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
        memoryExtractionLeases,
        memoryExtractionDispatch,
        memorySearchTermsBackfill,
        strandedMemories,
        lockedSourceMemories,
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
        memoryExtractionLeases,
        memoryExtractionDispatch,
        memorySearchTermsBackfill,
        strandedMemories,
        lockedSourceMemories,
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
