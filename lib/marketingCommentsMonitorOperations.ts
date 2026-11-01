import "server-only";

import type { PrismaClient } from "@prisma/client";

import type { MarketingCommentsMonitorDeps } from "@/lib/marketingCommentsMonitor";
import { recordMarketingCommentsMonitorRun } from "@/lib/marketingCommentsMonitorHealth";
import {
  MARKETING_COMMENT_ALERT_UNHANDLED_LIMIT_MS,
  evaluateMarketingAutoPause,
  listMarketingPostsForCommentMonitor,
  listOpenMarketingCommentAlerts,
  readMarketingCommentAlertFloor,
  recordMarketingCommentAlert,
  runMarketingTransaction,
} from "@/lib/marketingStore";

/**
 * The monitor's database side. Every write is its own short transaction: a post
 * whose alert could not be recorded does not undo the ones before it, and the
 * stop of one account does not wait for another's.
 */
export const marketingCommentsMonitorOperations = (
  client: PrismaClient,
): MarketingCommentsMonitorDeps["operations"] => ({
  listPosts: (limit) =>
    runMarketingTransaction(client, (tx) =>
      listMarketingPostsForCommentMonitor(tx, { now: new Date(), limit }),
    ),
  alertFloor: (postId) => readMarketingCommentAlertFloor(client, postId),
  recordAlert: async (input) => {
    const outcome = await runMarketingTransaction(client, (tx) =>
      recordMarketingCommentAlert(tx, input),
    );
    return { recorded: outcome.recorded };
  },
  sweepUnhandled: async (now) => {
    const open = await listOpenMarketingCommentAlerts(client);
    // Per account, the newest overdue alert: the stop needs one that began after
    // the account's last fresh start, and the store decides that under the lock.
    const overdue = new Map<string, Date>();
    for (const alert of open) {
      if (
        alert.channelId !== null &&
        now.getTime() - alert.firstDetectedAt.getTime() >= MARKETING_COMMENT_ALERT_UNHANDLED_LIMIT_MS
      ) {
        const known = overdue.get(alert.channelId);
        if (!known || known.getTime() < alert.firstDetectedAt.getTime()) {
          overdue.set(alert.channelId, alert.firstDetectedAt);
        }
      }
    }
    let stopped = 0;
    for (const [channelId, forcedFactAt] of overdue) {
      const result = await runMarketingTransaction(client, (tx) =>
        evaluateMarketingAutoPause(tx, {
          channelId,
          forcedReason: "unhandled_comment_alert",
          forcedFactAt,
        }),
      );
      if (result.paused) stopped += 1;
    }
    return stopped;
  },
  recordRun: (at) => recordMarketingCommentsMonitorRun(client, at),
});
