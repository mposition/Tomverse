import "server-only";

import type { Prisma } from "@prisma/client";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
  getZonedDayWindow,
  type UserDayWindow,
} from "@/lib/userTimeZone";

const DAILY_USAGE_PERIODS = ["day", "tokens-day", "cost-day", "op-cost-day"] as const;
let didWarnAboutTimeZoneSchema = false;

export const getUserDayWindow = async (
  tx: Prisma.TransactionClient,
  userId: string,
  now = new Date()
): Promise<UserDayWindow> => {
  try {
    const settings = await tx.userSettings.findUnique({
      where: { userId },
      select: { timeZone: true },
    });
    return getZonedDayWindow(settings?.timeZone, now);
  } catch (error) {
    // UTC was the policy before the time-zone migration, so it is the only
    // safe fallback while old and new application instances overlap.
    if (isMissingDatabaseSchemaError(error)) {
      if (!didWarnAboutTimeZoneSchema) {
        didWarnAboutTimeZoneSchema = true;
        console.warn(
          "User time-zone schema is not migrated yet; using UTC daily windows."
        );
      }
      return getZonedDayWindow("UTC", now);
    }
    throw error;
  }
};

/** The settings transaction holds the account lock, then the usage-subject lock. */
export const migrateCurrentDailyUsageBuckets = async (
  tx: Prisma.TransactionClient,
  input: {
    key: string;
    previousTimeZone: unknown;
    nextTimeZone: unknown;
    now?: Date;
  }
) => {
  const now = input.now || new Date();
  const previousWindow = getZonedDayWindow(input.previousTimeZone, now);
  const nextWindow = getZonedDayWindow(input.nextTimeZone, now);

  if (previousWindow.start.getTime() === nextWindow.start.getTime()) {
    return { previousWindow, nextWindow, movedPeriods: 0 };
  }

  let movedPeriods = 0;
  for (const period of DAILY_USAGE_PERIODS) {
    const previousBucket = await tx.chatUsageBucket.findUnique({
      where: {
        key_period_periodStart: {
          key: input.key,
          period,
          periodStart: previousWindow.start,
        },
      },
      select: { count: true },
    });
    if (!previousBucket) continue;

    await tx.chatUsageBucket.upsert({
      where: {
        key_period_periodStart: {
          key: input.key,
          period,
          periodStart: nextWindow.start,
        },
      },
      create: {
        key: input.key,
        period,
        periodStart: nextWindow.start,
        count: previousBucket.count,
      },
      update: {
        count: { increment: previousBucket.count },
      },
    });
    await tx.chatUsageBucket.delete({
      where: {
        key_period_periodStart: {
          key: input.key,
          period,
          periodStart: previousWindow.start,
        },
      },
    });
    movedPeriods += 1;
  }

  // A task's dayStart is its refundable bucket reference, not a pricing
  // snapshot. Move it with that exact current bucket, including closed tasks
  // that can still receive a late provider receipt. Historical days stay put.
  // Settings also runs while the default-off Code schema is not deployed yet.
  const [codeSchema] = await tx.$queryRaw<Array<{ exists: boolean }>>`
    SELECT to_regclass('"CodeTaskReservation"') IS NOT NULL AS "exists"
  `;
  if (codeSchema.exists) {
    await tx.$executeRaw`
      UPDATE "CodeTaskReservation" SET "dayStart"=${nextWindow.start},"updatedAt"=${now}
      WHERE "subjectKey"=${input.key} AND "dayStart"=${previousWindow.start} AND "userId" IS NOT NULL
    `;
  }

  return { previousWindow, nextWindow, movedPeriods };
};
