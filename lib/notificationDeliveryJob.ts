import "server-only";

import {
  NOTIFICATION_QUEUE_DEPTH_ALERT,
  drainNotificationDeliveries,
  type NotificationDrainResult,
} from "@/lib/notificationDeliveries";
import { sweepExpiredCredentialDeliveries } from "@/lib/credentialEmailLane";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  completeScheduledJob,
  failScheduledJob,
  startScheduledJob,
} from "@/lib/scheduledJobs";

/**
 * One drain pass, wrapped in the scheduled-job bookkeeping the operations
 * console reads.
 *
 * Two callers share it: the dedicated maintenance endpoint, and the credit
 * reconciliation cron that already runs every fifteen minutes. Having both means
 * the queue keeps draining on an existing schedule -- no new cron entry has to
 * be provisioned before this starts working -- while still offering an
 * explicit endpoint to run or re-run it on demand.
 */
export async function runNotificationDeliveryDrain(options?: {
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  now?: Date;
}): Promise<NotificationDrainResult> {
  const run = await startScheduledJob("notification_delivery_retry");
  try {
    const result = await drainNotificationDeliveries(options);
    await completeScheduledJob({
      runId: run?.id,
      processedCount: result.claimed,
      result,
    });
    if (result.abandoned > 0) {
      // Abandonment is the one outcome nobody else will notice: the report is
      // safely stored, so the product looks fine while the team never hears
      // about it. Raised without the reporter's content -- counts only.
      await reportOperationalIncident({
        code: "NOTIFICATION_DELIVERY_ABANDONED",
        title: "Operator notifications were abandoned after repeated failures",
        error: `${result.abandoned} notification(s) exhausted their retries`,
        severity: "error",
        cooldownMs: 30 * 60 * 1_000,
        context: {
          component: "notification-delivery-retry",
          abandoned: result.abandoned,
          pending: result.pending,
        },
      });
    }
    // A queue that is deep, or a pass that ran out of budget before clearing
    // it, is a backlog. Said out loud here so it is noticed while the mail is
    // merely late, rather than after it has abandoned.
    if (result.pending >= NOTIFICATION_QUEUE_DEPTH_ALERT || !result.exhausted) {
      await reportOperationalIncident({
        code: "NOTIFICATION_DELIVERY_BACKLOG",
        title: "Operator notification queue is not keeping up",
        error: `${result.pending} notification(s) still pending after ${result.batches} batch(es)`,
        severity: "warning",
        cooldownMs: 30 * 60 * 1_000,
        context: {
          component: "notification-delivery-retry",
          pending: result.pending,
          batches: result.batches,
          exhausted: result.exhausted,
        },
      });
    }
    // Credential rows are closed out on the same tick rather than on a cron of
    // their own, for the reason this file already gives about the drain: an
    // upkeep pass that needs a schedule provisioned before it does anything is
    // an upkeep pass that does nothing for a while.
    //
    // It is a sweep, not a retry. Nothing in the database can rebuild a login
    // code (see lib/credentialEmailLane.ts), so all this does is stop rows
    // whose credential has since expired from sitting in the console as sends
    // still waiting to happen. Its failure must not fail the drain, which is
    // the part with a queue behind it.
    try {
      const sweep = await sweepExpiredCredentialDeliveries();
      if (sweep.swept > 0) {
        console.info(
          JSON.stringify({
            event: "credential_email_sweep",
            swept: sweep.swept,
            at: new Date().toISOString(),
          })
        );
      }
    } catch (sweepError) {
      console.error(
        JSON.stringify({
          event: "credential_email_sweep_failed",
          reason: sweepError instanceof Error ? sweepError.name : "unknown",
          at: new Date().toISOString(),
        })
      );
    }

    return result;
  } catch (error) {
    await failScheduledJob({ runId: run?.id, error });
    throw error;
  }
}

/**
 * The piggybacked variant: never throws, so a queue problem cannot fail the
 * job it is riding along with.
 */
export async function drainNotificationDeliveriesQuietly(options?: {
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
}) {
  try {
    return await runNotificationDeliveryDrain(options);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "notification_delivery_drain_failed",
        reason: error instanceof Error ? error.name : "unknown",
        at: new Date().toISOString(),
      })
    );
    return null;
  }
}
