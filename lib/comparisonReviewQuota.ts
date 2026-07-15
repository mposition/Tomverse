import "server-only";

import { prisma } from "@/lib/prisma";
import { ChatAccessError } from "@/lib/chatSecurity";

export type ComparisonReviewQuotaReservation = {
  key: string;
  periodStart: Date;
};

export const getFreeComparisonReviewLimit = () => {
  const value = Number(process.env.COMPARISON_REVIEW_FREE_PER_MONTH);
  return Number.isSafeInteger(value) && value > 0 ? value : 3;
};

export const reserveFreeComparisonReview = async (
  subjectKey: string
): Promise<ComparisonReviewQuotaReservation> => {
  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const key = `${subjectKey}:comparison-review`;
  const limit = getFreeComparisonReviewLimit();
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, 'comparison-review-month', ${periodStart}, 1, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + 1,
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."count" < ${limit}
    RETURNING "count"
  `;
  if (rows.length === 0) {
    throw new ChatAccessError(
      429,
      "COMPARISON_REVIEW_MONTHLY_LIMIT",
      `The Free plan includes ${limit} AI comparison reviews per month.`
    );
  }
  return { key, periodStart };
};

export const releaseFreeComparisonReview = async (
  reservation: ComparisonReviewQuotaReservation
) => {
  await prisma.chatUsageBucket.updateMany({
    where: {
      key: reservation.key,
      period: "comparison-review-month",
      periodStart: reservation.periodStart,
      count: { gt: 0 },
    },
    data: { count: { decrement: 1 } },
  });
};
