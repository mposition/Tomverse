import "server-only";

import type { Prisma } from "@prisma/client";
import {
  getZonedDayWindow,
  type UserDayWindow,
} from "@/lib/userTimeZone";

const DAILY_USAGE_PERIODS = ["day", "tokens-day", "cost-day"] as const;

export const getUserDayWindow = async (
  tx: Prisma.TransactionClient,
  userId: string,
  now = new Date()
): Promise<UserDayWindow> => {
  const settings = await tx.userSettings.findUnique({
    where: { userId },
    select: { timeZone: true },
  });
  return getZonedDayWindow(settings?.timeZone, now);
};

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

  return { previousWindow, nextWindow, movedPeriods };
};
