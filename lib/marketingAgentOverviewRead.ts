import "server-only";

import { Prisma } from "@prisma/client";

import { MARKETING_LLM_COUNTED_MICRO_USD_SQL } from "@/lib/marketingLlmBudgetStore";
import {
  marketingExcerptLine,
  marketingWeekPosts,
  type MarketingAgentOverview,
  type MarketingRecentRun,
  type MarketingScheduledPost,
  type MarketingWeekPosts,
} from "@/lib/marketingAgentOverviewCore";
import { prisma } from "@/lib/prisma";

const SCHEDULED_LIMIT = 4;
const RUN_LIMIT = 4;
/** More than a fortnight of drafts is far past what the generator writes; the cap only bounds the read. */
const WEEK_READ_LIMIT = 5000;

const settle = async <T>(read: string, run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch {
    // The error text is not logged: a database error can carry query text.
    console.warn({ event: "admin_marketing_agent_overview_read_failed", read });
    return null;
  }
};

/**
 * Read-only. Posts written per Brisbane day, the next scheduled posts and the
 * generator's latest runs, from the tables the console already reads. Nothing
 * here writes, calls the publisher or reaches an outside service.
 */
export async function readMarketingAgentOverview(now: Date = new Date()): Promise<MarketingAgentOverview> {
  const [week, scheduled, runs] = await Promise.all([
    settle<MarketingWeekPosts>("week", async () => {
      const posts = await prisma.marketingPost.findMany({
        where: { createdAt: { gte: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000) } },
        select: { createdAt: true },
        take: WEEK_READ_LIMIT,
      });
      return marketingWeekPosts(posts.map((post) => post.createdAt), now);
    }),
    settle<MarketingScheduledPost[]>("scheduled", async () => {
      const posts = await prisma.marketingPost.findMany({
        where: { status: "scheduled", scheduledAt: { not: null } },
        orderBy: { scheduledAt: "asc" },
        take: SCHEDULED_LIMIT,
        select: {
          id: true,
          locale: true,
          scheduledAt: true,
          envelope: true,
          channel: { select: { channel: true, accountSlug: true } },
        },
      });
      return posts.flatMap((post) =>
        post.scheduledAt
          ? [
              {
                id: post.id,
                channel: post.channel.channel,
                accountSlug: post.channel.accountSlug,
                locale: post.locale,
                scheduledAt: post.scheduledAt.toISOString(),
                excerpt: marketingExcerptLine(post.envelope),
              },
            ]
          : [],
      );
    }),
    settle<MarketingRecentRun[]>("runs", async () => {
      const rows = await prisma.$queryRaw<
        Array<{ id: string; at: Date; calls: number; counted: bigint; unsettled: number }>
      >(Prisma.sql`
        SELECT "generatorRunId" AS "id",
               max("createdAt") AS "at",
               count(*)::int AS "calls",
               COALESCE(sum(${MARKETING_LLM_COUNTED_MICRO_USD_SQL}), 0)::bigint AS "counted",
               (count(*) FILTER (WHERE "state" NOT IN ('settled', 'released')))::int AS "unsettled"
        FROM "MarketingLlmCall"
        GROUP BY "generatorRunId"
        ORDER BY max("createdAt") DESC
        LIMIT ${RUN_LIMIT}
      `);
      return rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        calls: row.calls,
        countedMicroUsd: Number(row.counted),
        unsettled: row.unsettled,
      }));
    }),
  ]);
  return { week, scheduled, runs };
}
