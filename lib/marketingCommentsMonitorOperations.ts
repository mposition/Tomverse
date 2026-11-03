import "server-only";

import type { PrismaClient } from "@prisma/client";

import type { MarketingCommentsMonitorDeps } from "@/lib/marketingCommentsMonitor";
import {
  readMarketingCommentsMonitorLastRun,
  recordMarketingCommentsMonitorRun,
} from "@/lib/marketingCommentsMonitorHealth";
import {
  MARKETING_COMMENT_ALERT_UNHANDLED_LIMIT_MS,
  evaluateMarketingAutoPause,
  listMarketingPostsForCommentMonitor,
  listOpenMarketingCommentAlerts,
  readMarketingCommentAlertAnswers,
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
  lastCompleteRunAt: () => readMarketingCommentsMonitorLastRun(client),
  alertAnswers: (postIds) => readMarketingCommentAlertAnswers(client, postIds),
  recordAlert: async (input) => {
    const outcome = await runMarketingTransaction(client, (tx) =>
      recordMarketingCommentAlert(tx, input),
    );
    return outcome.recorded ? { recorded: true } : { recorded: false, reason: outcome.reason };
  },
  sweepUnhandled: async (now) => {
    const open = await listOpenMarketingCommentAlerts(client);
    // The overdue alerts of each account. The stop re-checks them under the lock.
    const overdue = new Map<string, Array<{ postId: string; firstDetectedAt: Date }>>();
    for (const alert of open) {
      if (
        alert.channelId !== null &&
        now.getTime() - alert.firstDetectedAt.getTime() >= MARKETING_COMMENT_ALERT_UNHANDLED_LIMIT_MS
      ) {
        const list = overdue.get(alert.channelId) ?? [];
        list.push({ postId: alert.postId, firstDetectedAt: alert.firstDetectedAt });
        overdue.set(alert.channelId, list);
      }
    }
    let stopped = 0;
    for (const [channelId, forcedAlerts] of overdue) {
      const result = await runMarketingTransaction(client, (tx) =>
        evaluateMarketingAutoPause(tx, {
          channelId,
          forcedReason: "unhandled_comment_alert",
          forcedAlerts,
          forcedOverdueBefore: new Date(now.getTime() - MARKETING_COMMENT_ALERT_UNHANDLED_LIMIT_MS),
        }),
      );
      if (result.paused) stopped += 1;
    }
    return stopped;
  },
  recordRun: (at) => recordMarketingCommentsMonitorRun(client, at),
});
