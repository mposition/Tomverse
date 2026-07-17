import assert from "node:assert/strict";
import test from "node:test";

import { migrateCurrentDailyUsageBuckets } from "../lib/userDailyUsage.ts";
import { getZonedDayWindow } from "../lib/userTimeZone.ts";

const bucketId = (key, period, periodStart) =>
  `${key}|${period}|${periodStart.toISOString()}`;

const createFakeTransaction = (initialBuckets) => {
  const buckets = new Map(
    initialBuckets.map((bucket) => [
      bucketId(bucket.key, bucket.period, bucket.periodStart),
      { ...bucket },
    ])
  );

  return {
    buckets,
    chatUsageBucket: {
      async findUnique({ where }) {
        const identity = where.key_period_periodStart;
        const bucket = buckets.get(
          bucketId(identity.key, identity.period, identity.periodStart)
        );
        return bucket ? { count: bucket.count } : null;
      },
      async upsert({ where, create, update }) {
        const identity = where.key_period_periodStart;
        const id = bucketId(identity.key, identity.period, identity.periodStart);
        const existing = buckets.get(id);
        if (existing) {
          existing.count += update.count.increment;
          return existing;
        }
        buckets.set(id, { ...create });
        return create;
      },
      async delete({ where }) {
        const identity = where.key_period_periodStart;
        buckets.delete(bucketId(identity.key, identity.period, identity.periodStart));
      },
    },
  };
};

test("moves and merges current daily usage so a time-zone change grants no reset", async () => {
  const now = new Date("2026-07-17T03:00:00.000Z");
  const oldWindow = getZonedDayWindow("UTC", now);
  const nextWindow = getZonedDayWindow("Australia/Brisbane", now);
  const key = "user:test";
  const transaction = createFakeTransaction([
    { key, period: "day", periodStart: oldWindow.start, count: 7 },
    { key, period: "tokens-day", periodStart: oldWindow.start, count: 900 },
    { key, period: "cost-day", periodStart: oldWindow.start, count: 1200 },
    { key, period: "day", periodStart: nextWindow.start, count: 2 },
  ]);

  const result = await migrateCurrentDailyUsageBuckets(transaction, {
    key,
    previousTimeZone: "UTC",
    nextTimeZone: "Australia/Brisbane",
    now,
  });

  assert.equal(result.movedPeriods, 3);
  assert.equal(
    transaction.buckets.get(bucketId(key, "day", nextWindow.start)).count,
    9
  );
  assert.equal(
    transaction.buckets.get(bucketId(key, "tokens-day", nextWindow.start)).count,
    900
  );
  assert.equal(
    transaction.buckets.get(bucketId(key, "cost-day", nextWindow.start)).count,
    1200
  );
  assert.equal(
    transaction.buckets.has(bucketId(key, "day", oldWindow.start)),
    false
  );
});

test("does not rewrite buckets when both zones share the same midnight instant", async () => {
  const now = new Date("2026-07-17T03:00:00.000Z");
  const transaction = createFakeTransaction([]);
  const result = await migrateCurrentDailyUsageBuckets(transaction, {
    key: "user:test",
    previousTimeZone: "UTC",
    nextTimeZone: "Etc/UTC",
    now,
  });

  assert.equal(result.movedPeriods, 0);
});
