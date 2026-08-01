import "server-only";

import { prisma } from "@/lib/prisma";
import { usageBucketCount } from "@/lib/chatUsageBucketCount";
import { ChatAccessError } from "@/lib/chatSecurity";

export type ComparisonReviewQuotaReservation = {
  key: string;
  period: string;
  periodStart: Date;
};

const FREE_PERIOD = "comparison-review-month";
const GUEST_PERIOD = "guest-comparison-review-month";

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getFreeComparisonReviewLimit = () =>
  positiveInteger(process.env.COMPARISON_REVIEW_FREE_PER_MONTH, 3);

/**
 * How many AI cross-reviews one guest identity may run per calendar month.
 * Configurable so the trial can be widened or closed without a deploy, and
 * read by both the API and (through the preview response) the UI, so the
 * number is never written twice.
 */
export const getGuestComparisonReviewLimit = () =>
  positiveInteger(process.env.CHAT_GUEST_AI_REVIEW_PER_MONTH, 1);

const monthStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

/**
 * Claims one slot of a monthly review quota, atomically.
 *
 * The conditional upsert is the whole point: the row is inserted or
 * incremented in a single statement whose `WHERE` refuses to go past the
 * limit, so two requests racing for the last slot cannot both win, and no
 * read-then-write window exists for a double click to slip through.
 */
const reserveMonthlyReview = async (
  subjectKey: string,
  period: string,
  keySuffix: string,
  limit: number,
  error: () => ChatAccessError
): Promise<ComparisonReviewQuotaReservation> => {
  const periodStart = monthStart();
  const key = `${subjectKey}:${keySuffix}`;
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${period}, ${periodStart}, 1, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + 1,
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."count" < ${limit}
    RETURNING "count"
  `;
  if (rows.length === 0) throw error();
  return { key, period, periodStart };
};

const readMonthlyReviewCount = async (
  subjectKey: string,
  period: string,
  keySuffix: string
) => {
  const bucket = await prisma.chatUsageBucket.findUnique({
    where: {
      key_period_periodStart: {
        key: `${subjectKey}:${keySuffix}`,
        period,
        periodStart: monthStart(),
      },
    },
    select: { count: true },
  });
  return usageBucketCount(bucket?.count);
};

export const reserveFreeComparisonReview = (subjectKey: string) =>
  reserveMonthlyReview(
    subjectKey,
    FREE_PERIOD,
    "comparison-review",
    getFreeComparisonReviewLimit(),
    () =>
      new ChatAccessError(
        429,
        "COMPARISON_REVIEW_MONTHLY_LIMIT",
        `The Free plan includes ${getFreeComparisonReviewLimit()} AI comparison reviews per month.`
      )
  );

export const reserveGuestComparisonReview = (subjectKey: string) =>
  reserveMonthlyReview(
    subjectKey,
    GUEST_PERIOD,
    "guest-comparison-review",
    getGuestComparisonReviewLimit(),
    () =>
      new ChatAccessError(
        429,
        "GUEST_COMPARISON_REVIEW_MONTHLY_LIMIT",
        `Guests can run ${getGuestComparisonReviewLimit()} AI review per month. Sign in for more.`
      )
  );

/** How many trial runs this guest identity has left this month. */
export const getGuestComparisonReviewRemaining = async (subjectKey: string) => {
  const limit = getGuestComparisonReviewLimit();
  const used = await readMonthlyReviewCount(
    subjectKey,
    GUEST_PERIOD,
    "guest-comparison-review"
  );
  return { limit, used, remaining: Math.max(0, limit - used) };
};

/**
 * Hands a claimed slot back when the run it was claimed for never happened.
 * A review that failed before producing a result must not consume the one
 * trial a guest gets, and the same has always been true of the Free plan's
 * three.
 */
export const releaseComparisonReviewQuota = async (
  reservation: ComparisonReviewQuotaReservation
) => {
  await prisma.chatUsageBucket.updateMany({
    where: {
      key: reservation.key,
      period: reservation.period,
      periodStart: reservation.periodStart,
      count: { gt: 0 },
    },
    data: { count: { decrement: 1 } },
  });
};

/** @deprecated Use {@link releaseComparisonReviewQuota}. */
export const releaseFreeComparisonReview = releaseComparisonReviewQuota;
