/**
 * Long enough for the extraction dispatch this route now ends with.
 *
 * That pass is bounded at `MEMORY_EXTRACTION_DISPATCH_BUDGET_MS` (120s) and
 * may overrun by at most one chunk timeout (60s), because a chunk already
 * claimed is always allowed to finish -- 180s for the dispatch, plus the
 * reconciliation, queue drains and sweeps above it. Undeclared, the platform
 * default decided this, and a truncated pass would abandon leases it had just
 * claimed.
 */
export const maxDuration = 300;

import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { reconcileExpiredChatCreditReservations } from "@/lib/chatSecurity";
import {
  databaseErrorMetadata,
  isRetryableDatabaseError,
} from "@/lib/databaseError";
import { reconcileExpiredChatRequestLeases } from "@/lib/chatRequestLease";
import { reconcileSourceLockedMemories } from "@/lib/externalConversationLockService";
import { reconcileExpiredExternalImportStaging } from "@/lib/externalImportService";
import { reconcileExpiredMemories } from "@/lib/memoryExpiryService";
import { reconcileUnsettledExtractionProviderCalls } from "@/lib/memoryExtractionProviderCost";
import { dispatchPendingMemoryExtractionRuns } from "@/lib/memoryExtractionWorker";
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
import { runGeneratedArtifactMaintenanceQuietly } from "@/lib/generatedArtifactStorage";
import { runMessageAttachmentMaintenanceQuietly } from "@/lib/messageAttachmentStorage";

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

/**
 * The reconciliation sweep, retried once when the database connection dropped
 * under it.
 *
 * A managed Postgres restart severs in-flight connections, which Prisma
 * surfaces as `08P01` / "server conn crashed?". The sweep is idempotent -- it
 * moves expired reservations to a terminal state and counts the ones already
 * there -- so a second attempt on a fresh connection is exactly what the next
 * scheduled run would do fifteen minutes later, only sooner.
 */
const reconcileCreditReservationsWithRetry = async () => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await reconcileExpiredChatCreditReservations(new Date(), 1_000);
    } catch (error) {
      if (attempt > 0 || !isRetryableDatabaseError(error)) throw error;
      console.warn(
        JSON.stringify({
          event: "credit_reservation_reconciliation_retry",
          ...databaseErrorMetadata(error),
          timestamp: new Date().toISOString(),
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
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
    const result = await reconcileCreditReservationsWithRetry();
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
    // The same two arms for generated files: drain the deletion tombstones
    // against object storage, then reclaim objects whose row write never
    // landed. Never throws, so it cannot turn a successful reconciliation
    // into a failed one (docs/policy/generated-artifacts.md section 8).
    const generatedArtifacts = await runGeneratedArtifactMaintenanceQuietly();
    // And the tombstones for the files users uploaded. Same never-throws
    // contract, same fifteen-minute cadence: a deletion that committed in the
    // database is a deletion that has to reach object storage eventually, and
    // this is the arm that retries until it does
    // (docs/policy/user-attachment-persistence.md).
    const messageAttachments = await runMessageAttachmentMaintenanceQuietly();
    // Staged external-import payloads carry user conversation content and a
    // 24h-idle / 72h-absolute lifetime (policy §5.5). The lazy checks in
    // batch/finalize are the primary guard; this sweep clears content whose
    // owner never came back. Never throws, so it cannot turn a successful
    // reconciliation into a failed one.
    const externalImportStaging =
      await reconcileExpiredExternalImportStaging().catch(() => ({
        expiredImports: 0,
      }));
    // Memory expiry (policy §8.6): retrieval already refuses an expired
    // memory whichever status it holds, so this is about the row saying so —
    // the owner sees it as expired, and the account's memory fingerprint
    // moves, which retires any §10 bundle priced against the old set. Never
    // throws, so it cannot turn a successful reconciliation into a failed one.
    const memoryExpiry = await reconcileExpiredMemories().catch(() => ({
      expiredMemories: 0,
      truncated: false,
    }));
    // Source-lock convergence (policy §7.1): the lock transition is atomic, so
    // this exists for the drift the transaction cannot see -- evidence added
    // to a memory after its source was locked, or a source unlocked while a
    // memory was being edited. Same never-throws rule as the sweep above.
    const memorySourceLocks = await reconcileSourceLockedMemories().catch(
      () => ({
        memoriesSuspended: 0,
        memoriesRestored: 0,
        memoriesExpired: 0,
        truncated: false,
      })
    );
    // Extraction provider calls that went out and never settled (policy §3,
    // §11 "idempotent settlement"). A worker killed between issuing a request
    // and recording what it cost leaves the attempt open forever: its
    // reservation still holds the operational budget, but nothing says the
    // call finished, so the settled figure any later audit reads is missing a
    // call that really happened. The sweep settles it at the reservation --
    // "we know it happened and not what it cost" -- which is the conservative
    // direction and the only honest one.
    //
    // Before the dispatcher rather than after: this is a DB-only sweep, and
    // the dispatcher is the one step here that waits on a provider. It is also
    // the sweep that finalises the dead attempts of the very runs the
    // dispatcher is about to retry. Its cutoff is fifteen minutes against a
    // sixty-second chunk timeout, so no live call is ever inside the window.
    // Never throws, so it cannot turn a successful reconciliation into a
    // failed one.
    const memoryExtractionProviderCalls =
      await reconcileUnsettledExtractionProviderCalls().catch(() => ({
        settled: 0,
      }));
    // Memory extraction recovery (policy §11.1), deliberately last.
    //
    // This is the *dispatcher*, not only the lease sweep: reclaiming an expired
    // lease returns a run to `pending`, and §11.1 is explicit that a reclaimed
    // run nobody re-drives sits there forever unless a request happens to
    // arrive. So it reclaims and then drives what is pending.
    //
    // It runs after everything above because it is the only step here that
    // waits on a third-party model. It carries its own wall-clock ceiling as
    // well as a run cap -- a run count is not a time bound -- but ordering it
    // last means even a pathological provider cannot delay the credit, refund
    // and notification work, which is §11.1's actual requirement. Never throws.
    const memoryExtractionDispatch =
      await dispatchPendingMemoryExtractionRuns().catch(() => ({
        reclaimedRuns: 0,
        dispatchedRuns: 0,
        chunksProcessed: 0,
        skippedForTime: 0,
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
        generatedArtifacts,
        messageAttachments,
        externalImportStaging,
        memoryExtractionProviderCalls,
        memoryExtractionDispatch,
        memoryExpiry,
        memorySourceLocks,
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
        generatedArtifacts,
        messageAttachments,
        externalImportStaging,
        memoryExtractionProviderCalls,
        memoryExtractionDispatch,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    // A dropped database connection that survived the retry above is a
    // deferral, not a broken reconciliation: the sweep is idempotent and the
    // next run is fifteen minutes away. It is reported -- so a database that
    // stays unreachable is still loud -- but not as the fatal incident that
    // says the reconciliation itself failed, and the caller is told to come
    // back rather than being handed a 500 it will exit non-zero on.
    const retryable = isRetryableDatabaseError(error);
    after(() =>
      reportOperationalIncident({
        code: retryable
          ? "CREDIT_RESERVATION_RECONCILIATION_DEFERRED"
          : "CREDIT_RESERVATION_RECONCILIATION_FAILED",
        title: retryable
          ? "Credit reservation reconciliation deferred by the database"
          : "Credit reservation reconciliation failed",
        error,
        severity: retryable ? "error" : "fatal",
        cooldownMs: 15 * 60 * 1_000,
        context: {
          component: "maintenance-credit-reservations",
          route: "/api/internal/maintenance/credit-reservations",
          ...(retryable ? databaseErrorMetadata(error) : {}),
        },
      })
    );
    if (retryable) {
      return Response.json(
        {
          error: "Credit reservation reconciliation is temporarily unavailable.",
          code: "CREDIT_RESERVATION_RECONCILIATION_DEFERRED",
          retryable: true,
        },
        {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "60" },
        }
      );
    }
    return Response.json(
      { error: "Credit reservation reconciliation failed." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
