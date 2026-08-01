import "server-only";

import {
  drainNotificationDeliveries,
  type NotificationDrainResult,
} from "@/lib/notificationDeliveries";
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
 * reconciliation cron that already runs every five minutes. Having both means
 * the queue keeps draining on an existing schedule -- no new cron entry has to
 * be provisioned before this starts working -- while still offering an
 * explicit endpoint to run or re-run it on demand.
 */
export async function runNotificationDeliveryDrain(options?: {
  limit?: number;
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
  limit?: number;
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
