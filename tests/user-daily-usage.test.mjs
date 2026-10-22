import assert from "node:assert/strict";
import test from "node:test";

import { migrateCurrentDailyUsageBuckets } from "../lib/userDailyUsage.ts";
import { getZonedDayWindow } from "../lib/userTimeZone.ts";

const bucketId = (key, period, periodStart) =>
  `${key}|${period}|${periodStart.toISOString()}`;

const createFakeTransaction = (initialBuckets, codeTasks = [], codeSchemaExists = true) => {
  const buckets = new Map(
    initialBuckets.map((bucket) => [
      bucketId(bucket.key, bucket.period, bucket.periodStart),
      { ...bucket },
    ])
  );

  return {
    buckets,
    async $queryRaw() { return [{ exists: codeSchemaExists }]; },
    async $executeRaw(_query, nextStart, _now, key, previousStart) {
      assert.equal(codeSchemaExists,true,'an absent Code table must never be queried');
      for(const task of codeTasks)if(task.userId!==null&&task.subjectKey===key&&task.dayStart.getTime()===previousStart.getTime())task.dayStart=nextStart;
      return 0;
    },
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
    { key, period: "op-cost-day", periodStart: oldWindow.start, count: 1500 },
    { key, period: "day", periodStart: nextWindow.start, count: 2 },
  ]);

  const result = await migrateCurrentDailyUsageBuckets(transaction, {
    key,
    previousTimeZone: "UTC",
    nextTimeZone: "Australia/Brisbane",
    now,
  });

  assert.equal(result.movedPeriods, 4);
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
  assert.equal(transaction.buckets.get(bucketId(key,"op-cost-day",nextWindow.start)).count,1500);
  assert.equal(
    transaction.buckets.has(bucketId(key, "day", oldWindow.start)),
    false
  );
});

test("moves current Code refund references with their buckets, including closed tasks, while history stays put",async()=>{
  const now=new Date('2026-10-22T03:00:00Z'),old=getZonedDayWindow('Australia/Brisbane',now),next=getZonedDayWindow('Asia/Seoul',now),key='user:test';
  const tasks=[
    {userId:'u',subjectKey:key,status:'active',dayStart:old.start},
    {userId:'u',subjectKey:key,status:'closed',dayStart:old.start},
    {userId:'u',subjectKey:key,status:'interrupted',dayStart:new Date(old.start.getTime()-86400000)},
    {userId:null,subjectKey:'deleted-account',dayStart:old.start},
    {userId:'other',subjectKey:'user:other',dayStart:old.start},
  ];
  await migrateCurrentDailyUsageBuckets(createFakeTransaction([],tasks),{key,previousTimeZone:old.timeZone,nextTimeZone:next.timeZone,now});
  assert.equal(tasks[0].dayStart.getTime(),next.start.getTime());assert.equal(tasks[1].dayStart.getTime(),next.start.getTime());
  assert.equal(tasks[2].dayStart.getTime(),old.start.getTime()-86400000);assert.equal(tasks[3].dayStart.getTime(),old.start.getTime());assert.equal(tasks[4].dayStart.getTime(),old.start.getTime());
});

test("existing time-zone settings work before the default-off Code table is migrated",async()=>{
  const now=new Date('2026-10-22T03:00:00Z'),old=getZonedDayWindow('UTC',now),next=getZonedDayWindow('Australia/Brisbane',now),key='user:test';
  const tx=createFakeTransaction([{key,period:'day',periodStart:old.start,count:7}],[],false);
  const result=await migrateCurrentDailyUsageBuckets(tx,{key,previousTimeZone:'UTC',nextTimeZone:'Australia/Brisbane',now});
  assert.equal(result.movedPeriods,1);assert.equal(tx.buckets.get(bucketId(key,'day',next.start)).count,7);
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
