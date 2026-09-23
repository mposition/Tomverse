// Taking a publishing slot, and giving it back.
//
// Contract: the S2 plan's "S2c — adapter contract and claim-only publisher",
// and the inventory rows for `marketing_post.claimed` and
// `marketing_post.claim_released`.
//
// The one sentence everything here is about: **a claim is not a dispatch.** The
// row stays `scheduled`, its history does not move, and `publishAttempt` and
// `providerRequestKey` are untouched -- those three are what say a request left
// for the platform, and in this slice nothing can, because there is no adapter
// and no credential.
//
// TypeScript and the `@/` alias for the reason
// `tests/marketingS2b2AutonomousInsert.test.ts` gives: a module reached by two
// specifier forms is loaded twice, and this file shares the store with that one.

import assert from "node:assert/strict";
import test from "node:test";

import {
  claimDueMarketingPost,
  marketingChannelCaps,
  releaseMarketingPostClaim,
  MarketingStoreRefusedError,
  MARKETING_CLAIM_LEASE_MS,
  MARKETING_CLAIM_RELEASE_REASONS,
  MARKETING_S2C_ACTIONS,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import {
  marketingPublishAdapterAvailable,
  resolveMarketingPublishAdapter,
} from "@/lib/marketingPublishAdapter";
import { MARKETING_CHANNEL_CAPS } from "@/lib/marketingAutomationSchema";

const CHANNEL_ID = "chn_linkedin_en";
const POST_ID = "post-due-1";
const TOKEN = "worker-1:attempt-1";
const NOW = new Date("2026-09-23T09:00:00.000Z");
const LEASE_UNTIL = new Date("2026-09-23T09:15:00.000Z");

const asTransaction = (database: unknown): MarketingTransaction =>
  database as MarketingTransaction;

type ChannelRow = {
  id: string;
  channel: string;
  accountSlug: string;
  status: string;
  connectionGeneration: number;
  dailyCapOverride: number | null;
  weeklyCapOverride: number | null;
};

const channelRow = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
  id: CHANNEL_ID,
  channel: "linkedin",
  accountSlug: "linkedin-1",
  status: "autonomous_mode",
  connectionGeneration: 1,
  dailyCapOverride: null,
  weeklyCapOverride: null,
  ...overrides,
});

const statementText = (query: unknown): string => {
  if (Array.isArray(query)) return query.join("?");
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

type Updated = { where: Record<string, unknown>; data: Record<string, unknown> };

/**
 * A database that answers the claim path's questions.
 *
 * Dispatched on what each statement says, and it throws on one it does not
 * recognise -- so a new read in the store fails the test rather than silently
 * receiving `undefined`.
 */
const fakeDatabase = (
  options: {
    channel?: ChannelRow | null;
    due?: string | null;
    today?: number;
    week?: number;
    updates?: number[];
    now?: Date;
    isolation?: string;
    dueHistoryVersion?: number;
    dueSlotDay?: string | null;
  } = {},
) => {
  const {
    channel = channelRow(),
    due = POST_ID,
    today = 0,
    week = 0,
    updates = [1],
    now = NOW,
    isolation = "serializable",
    dueHistoryVersion = 4,
    dueSlotDay = null,
  } = options;
  const seen: {
    updates: Updated[];
    audits: Record<string, unknown>[];
    sql: string[];
    countValues: (readonly unknown[])[];
  } = {
    updates: [],
    audits: [],
    sql: [],
    countValues: [],
  };
  let update = 0;
  const database = {
    async $executeRaw() {
      return 0;
    },
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      seen.sql.push(sql);
      if (sql.includes("transaction_isolation")) {
        return [{ level: isolation }];
      }
      if (sql.includes("count(*) FILTER")) {
        seen.countValues.push(
          (query as { values?: readonly unknown[] }).values ?? [],
        );
        return [{ today: BigInt(today), week: BigInt(week) }];
      }
      if (sql.includes("clock_timestamp")) return [{ now, createdAt: now }];
      if (sql.includes("FOR UPDATE OF p SKIP LOCKED")) {
        return due === null
          ? []
          : [{ id: due, historyVersion: dueHistoryVersion, slotDay: dueSlotDay }];
      }
      if (sql.includes("FOR UPDATE")) return channel === null ? [] : [channel];
      throw new Error(`unexpected raw statement: ${sql}`);
    },
    marketingChannel: { findUnique: async () => channel },
    marketingPost: {
      updateMany: async (input: Updated) => {
        seen.updates.push(input);
        const count = updates[update] ?? 0;
        update += 1;
        return { count };
      },
    },
    adminAuditLog: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seen.audits.push(data);
        return data;
      },
    },
  };
  return { database, seen };
};

const admits = async () => ({ publish: true });

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

test("there is no adapter in this build, and saying so is the answer", () => {
  // Not a throw. The publisher asks on its ordinary path, and "there is no
  // adapter" is the expected answer until S2d2 -- an exception would make
  // every caller handle it as a failure.
  assert.deepEqual(resolveMarketingPublishAdapter("zernio"), {
    available: false,
    reason: "no_adapter_implemented",
  });
  assert.deepEqual(resolveMarketingPublishAdapter("something-else"), {
    available: false,
    reason: "provider_not_recognised",
  });
  assert.equal(marketingPublishAdapterAvailable("zernio"), false);
});

test("the adapter module holds no credential and cannot reach outward", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../lib/marketingPublishAdapter.ts", import.meta.url),
      "utf8",
    ),
  );
  // Nothing that could make a call, and nothing that could hold a secret. The
  // credential belongs to the service that constructs an adapter, which is not
  // this module and is not in this build.
  for (const forbidden of [
    "fetch(",
    "process.env",
    "axios",
    "node:https",
    "Authorization",
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `the adapter contract must not contain ${forbidden}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

test("an operator's override lowers a cap and cannot raise one", () => {
  const policy = MARKETING_CHANNEL_CAPS.linkedin;
  assert.ok(policy);
  assert.deepEqual(
    marketingChannelCaps({
      channel: "linkedin",
      dailyCapOverride: null,
      weeklyCapOverride: null,
    }),
    { daily: policy.daily, weekly: policy.weekly },
  );
  assert.deepEqual(
    marketingChannelCaps({
      channel: "linkedin",
      dailyCapOverride: 99,
      weeklyCapOverride: 99,
    }),
    { daily: policy.daily, weekly: policy.weekly },
    "an override above the policy cap is not a cap, it is a request",
  );
  assert.deepEqual(
    marketingChannelCaps({
      channel: "x",
      dailyCapOverride: 1,
      weeklyCapOverride: 2,
    }),
    { daily: 1, weekly: 2 },
  );
  // RedNote is posted by hand: no policy cap, and an override cannot invent
  // one, because there is no automated posting to cap.
  assert.equal(
    marketingChannelCaps({
      channel: "rednote",
      dailyCapOverride: 5,
      weeklyCapOverride: 5,
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

test("a claim takes a slot and changes nothing else about the post", async () => {
  const { database, seen } = fakeDatabase();
  const result = await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });

  assert.ok(result.claimed);
  assert.equal(result.id, POST_ID);
  assert.equal(
    result.leaseUntil.getTime(),
    NOW.getTime() + MARKETING_CLAIM_LEASE_MS,
  );

  const [write] = seen.updates;
  assert.ok(write);
  assert.deepEqual(Object.keys(write.data).sort(), [
    "claimToken",
    "leaseUntil",
    "slotDate",
  ]);
  // Midnight of the database's UTC day, not the instant it happened to be.
  // The column is a `DATE`, and letting Prisma derive one from a timestamp is
  // how the written day and the counted day end up different.
  assert.deepEqual(write.data.slotDate, new Date("2026-09-23T00:00:00.000Z"));
  // And conditional on the version the decision was made against.
  assert.equal(write.where.historyVersion, 4);
  // The three that would say a request left for the platform, and the two that
  // would say the post moved on. None of them is written.
  for (const column of [
    "status",
    "history",
    "historyVersion",
    "publishAttempt",
    "providerRequestKey",
  ]) {
    assert.ok(
      !(column in write.data),
      `a claim must not write ${column}: it is not a dispatch`,
    );
  }
  assert.equal(write.where.status, "scheduled");

  const [audit] = seen.audits;
  assert.ok(audit);
  assert.equal(audit.action, MARKETING_S2C_ACTIONS.postClaimed);
  assert.equal(audit.targetId, POST_ID);
});

test("the due query is written to pass over what another worker holds", async () => {
  const { database, seen } = fakeDatabase();
  await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  // A fake cannot lock anything, so what this checks is the statement. The
  // behaviour -- two workers, one winner -- is proved against a real
  // PostgreSQL in tests/integration/marketing-automation-schema.db.test.ts.
  const due = seen.sql.find((sql) => sql.includes("SKIP LOCKED"));
  assert.ok(due, "the due query does not skip locked rows");
  // Locks the post and not the channel joined to it: the channel is locked
  // separately and on purpose, and a second lock on it here would be a
  // different order for a second caller to deadlock against.
  assert.match(due, /FOR UPDATE OF p SKIP LOCKED/);
  // Due means due at the database's clock, and an expired lease is reclaimable.
  assert.match(due, /"scheduledAt" <= /);
  assert.match(due, /"leaseUntil" <= /);
  // And not a third. A row holding a token with no lease would be selected,
  // locked, and matched by neither update -- every time.
  assert.doesNotMatch(due, /"leaseUntil" IS NULL/);
  // The day the row holds, as text, so it compares without a time zone.
  assert.match(due, /to_char\(p\."slotDate", 'YYYY-MM-DD'\)/);
  assert.match(due, /"status" = 'scheduled'/);
});

test("the channel is locked before the counts are read", async () => {
  const { database, seen } = fakeDatabase();
  await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  const lock = seen.sql.findIndex(
    (sql) => sql.includes("FOR UPDATE") && !sql.includes("SKIP LOCKED"),
  );
  const count = seen.sql.findIndex((sql) => sql.includes("count(*) FILTER"));
  assert.ok(lock >= 0 && count >= 0);
  assert.ok(
    lock < count,
    "counting before holding the channel lets two workers each take the last slot",
  );
});

test("a claim is refused at the day and the week cap", async () => {
  const policy = MARKETING_CHANNEL_CAPS.linkedin;
  assert.ok(policy);

  const atDay = fakeDatabase({ today: policy.daily });
  assert.deepEqual(
    await claimDueMarketingPost(asTransaction(atDay.database), {
      channelId: CHANNEL_ID,
      claimToken: TOKEN,
      resolveAdmission: admits,
    }),
    { claimed: false, reason: "daily_cap_reached" },
  );
  assert.equal(atDay.seen.updates.length, 0, "a refused claim writes nothing");

  const atWeek = fakeDatabase({ week: policy.weekly });
  assert.deepEqual(
    await claimDueMarketingPost(asTransaction(atWeek.database), {
      channelId: CHANNEL_ID,
      claimToken: TOKEN,
      resolveAdmission: admits,
    }),
    { claimed: false, reason: "weekly_cap_reached" },
  );
});

test("nothing due, a stopped account and a refused admission are answers, not errors", async () => {
  assert.deepEqual(
    await claimDueMarketingPost(
      asTransaction(fakeDatabase({ due: null }).database),
      { channelId: CHANNEL_ID, claimToken: TOKEN, resolveAdmission: admits },
    ),
    { claimed: false, reason: "nothing_due" },
  );

  for (const status of ["paused", "disconnected", "connect_pending"]) {
    assert.deepEqual(
      await claimDueMarketingPost(
        asTransaction(fakeDatabase({ channel: channelRow({ status }) }).database),
        { channelId: CHANNEL_ID, claimToken: TOKEN, resolveAdmission: admits },
      ),
      { claimed: false, reason: "channel_not_publishing" },
    );
  }

  assert.deepEqual(
    await claimDueMarketingPost(asTransaction(fakeDatabase().database), {
      channelId: CHANNEL_ID,
      claimToken: TOKEN,
      resolveAdmission: async () => ({ publish: false }),
    }),
    { claimed: false, reason: "not_admitted" },
  );

  assert.deepEqual(
    await claimDueMarketingPost(
      asTransaction(
        fakeDatabase({ channel: channelRow({ channel: "rednote" }) }).database,
      ),
      { channelId: CHANNEL_ID, claimToken: TOKEN, resolveAdmission: admits },
    ),
    { claimed: false, reason: "channel_posts_by_hand" },
  );
});

test("approval mode may claim: a slot is not an autonomy decision", async () => {
  // Someone approved the post; the publisher is carrying it out. Refusing here
  // would mean an approved post could only go out from an account that had
  // also graduated, which is not what approval means.
  const { database } = fakeDatabase({ channel: channelRow({ status: "approval_mode" }) });
  const result = await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  assert.ok(result.claimed);
});

test("two workers on one post: the second gets a conflict, not the slot", async () => {
  // Both updates find nothing -- the unclaimed predicate because the first
  // worker has the row, the expired-lease predicate because its lease is live.
  const { database, seen } = fakeDatabase({ updates: [0, 0] });
  assert.deepEqual(
    await claimDueMarketingPost(asTransaction(database), {
      channelId: CHANNEL_ID,
      claimToken: "worker-2:attempt-1",
      resolveAdmission: admits,
    }),
    { claimed: false, reason: "claim_conflict" },
  );
  assert.equal(seen.audits.length, 0, "a conflict writes no audit entry");
});

test("an expired lease is reclaimed, by a predicate that says so", async () => {
  // The first update finds nothing because the row is claimed; the second
  // takes it because the lease has run out. Two predicates rather than one, so
  // "nobody had it" and "somebody's lease expired" are different facts.
  const { database, seen } = fakeDatabase({ updates: [0, 1] });
  const result = await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  assert.ok(result.claimed);
  assert.equal(seen.updates.length, 2);
  assert.equal(seen.updates[0]?.where.claimToken, null);
  assert.deepEqual(seen.updates[1]?.where.leaseUntil, { lte: NOW });
});

test("a claim refuses a transaction that is not SERIALIZABLE", async () => {
  // The level is set where the transaction is opened, which is a different
  // file from the one that depends on it. Under read committed the channel
  // lock serialises two workers and each still reads its counts from a
  // snapshot taken before the other committed -- so the account's allowance is
  // counted twice and spent twice.
  for (const level of ["read committed", "repeatable read", ""]) {
    const { database, seen } = fakeDatabase({ isolation: level });
    await assert.rejects(
      claimDueMarketingPost(asTransaction(database), {
        channelId: CHANNEL_ID,
        claimToken: TOKEN,
        resolveAdmission: admits,
      }),
      (error: unknown) =>
        error instanceof MarketingStoreRefusedError &&
        error.code === "transaction_not_serializable",
    );
    assert.equal(seen.updates.length, 0);
    // Asked before anything is locked, so a wrong level costs nothing.
    assert.equal(seen.audits.length, 0);
  }
});

test("the count and the write are about one day, read once, as text", async () => {
  // Two earlier versions got the day wrong in opposite directions. Binding a
  // `Date` and casting it in SQL resolved the day in the session's time zone;
  // calling `clock_timestamp()` again in the count read a second clock, which
  // a transaction straddling UTC midnight sees as the next day. The day is now
  // one string, derived from the one clock read, and both the count and the
  // write come from it.
  const { database, seen } = fakeDatabase();
  await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  const count = seen.sql.find((sql) => sql.includes("count(*) FILTER"));
  assert.ok(count);
  assert.doesNotMatch(
    count,
    /clock_timestamp/,
    "a second clock read inside one transaction can be a different day",
  );
  assert.match(count, /::date/);
  // The day handed to the count is the text of the clock read's UTC date.
  assert.ok(
    (seen.countValues[0] ?? []).includes("2026-09-23"),
    "the count must be told the day as text, not as a timestamp",
  );
  // And the write names the same day.
  const [write] = seen.updates;
  assert.ok(write);
  assert.deepEqual(write.data.slotDate, new Date("2026-09-23T00:00:00.000Z"));
});

test("the count is of spent slots, and leaves out the row being claimed", async () => {
  const { database, seen } = fakeDatabase();
  await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  const count = seen.sql.find((sql) => sql.includes("count(*) FILTER"));
  assert.ok(count);
  // `slotDate` is the whole record. A status list on top of it made an
  // unpublish give the day back.
  assert.match(count, /"slotDate" IS NOT NULL/);
  assert.doesNotMatch(count, /"status" IN/);
  assert.doesNotMatch(count, /"deletedAt"/);
  // Without this row: it is about to spend today, and if it held an earlier
  // day that day moves with it rather than being counted twice.
  assert.match(count, /"id" <> /);
  assert.ok((seen.countValues[0] ?? []).includes(POST_ID));
});

test("renewing a slot the post already holds is not a new spend", async () => {
  // The blocker in round two. A worker dies holding today's slot on a channel
  // allowed one post a day; its lease runs out; the next worker reclaims the
  // same row. That row *is* today's one post. Counting it against the cap
  // refused its own renewal, so the only recovery path for a crashed worker
  // never succeeded.
  const policy = MARKETING_CHANNEL_CAPS.linkedin;
  assert.ok(policy);
  const { database, seen } = fakeDatabase({
    dueSlotDay: "2026-09-23",
    // The day is already at its cap -- with this very row in it.
    today: policy.daily,
    week: policy.weekly,
    // Held by a worker whose lease has expired: the first update misses, the
    // expired-lease one takes it.
    updates: [0, 1],
  });
  const result = await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: "worker-2:attempt-1",
    resolveAdmission: admits,
  });
  assert.ok(result.claimed, "a renewal must not be refused by its own slot");

  assert.equal(
    seen.countValues.length,
    0,
    "nothing is counted on a renewal: nothing new is being spent",
  );
  for (const write of seen.updates) {
    assert.ok(
      !("slotDate" in write.data),
      "a renewal leaves the day where it is",
    );
  }
  const [audit] = seen.audits;
  assert.ok(audit);
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.renewed, true);
  assert.equal(
    metadata.dailyUsedBefore,
    null,
    "a number here would suggest a cap check that did not run",
  );
});

test("a post held on an earlier day is a new spend today", async () => {
  // A failure somebody requeued, claimed again on a later day. It spends the
  // day it next goes out, and its earlier day moves with it.
  const { database, seen } = fakeDatabase({ dueSlotDay: "2026-09-20" });
  const result = await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  assert.ok(result.claimed);
  assert.equal(seen.countValues.length, 1, "a new spend is counted");
  const [write] = seen.updates;
  assert.ok(write);
  assert.deepEqual(write.data.slotDate, new Date("2026-09-23T00:00:00.000Z"));
});

test("a requeued post keeps its spent day and can still be claimed", async () => {
  // A failed post that was requeued is `scheduled` again with no claim token
  // and no lease, but it keeps the `slotDate` of the day it spent. Requiring
  // `slotDate: null` left it matching neither predicate, so it could never be
  // claimed again at all.
  const { database, seen } = fakeDatabase();
  const result = await claimDueMarketingPost(asTransaction(database), {
    channelId: CHANNEL_ID,
    claimToken: TOKEN,
    resolveAdmission: admits,
  });
  assert.ok(result.claimed);
  const [write] = seen.updates;
  assert.ok(write);
  assert.equal(write.where.claimToken, null);
  assert.ok(
    !("slotDate" in write.where),
    "a spent day is not a reason a post can never be claimed again",
  );
});

test("a caller that is broken is told so rather than answered", async () => {
  for (const input of [
    { claimToken: "" },
    { leaseMs: 0 },
    { leaseMs: -1 },
  ]) {
    await assert.rejects(
      claimDueMarketingPost(asTransaction(fakeDatabase().database), {
        channelId: CHANNEL_ID,
        claimToken: TOKEN,
        resolveAdmission: admits,
        ...input,
      }),
      (error: unknown) => error instanceof MarketingStoreRefusedError,
    );
  }
});

// ---------------------------------------------------------------------------
// The release
// ---------------------------------------------------------------------------

test("a release gives back exactly what a claim took", async () => {
  const { database, seen } = fakeDatabase();
  const result = await releaseMarketingPostClaim(asTransaction(database), {
    id: POST_ID,
    claimToken: TOKEN,
    expectedLeaseUntil: LEASE_UNTIL,
    expectedHistoryVersion: 3,
    reason: "worker_shutdown",
  });
  assert.deepEqual(result, { released: true });

  const [write] = seen.updates;
  assert.ok(write);
  assert.deepEqual(write.data, {
    slotDate: null,
    claimToken: null,
    leaseUntil: null,
  });
  // It has to be this claim. A release matching only on the post id would let
  // a worker whose lease had already expired clear the new holder's claim.
  assert.equal(write.where.claimToken, TOKEN);
  assert.equal(write.where.historyVersion, 3);
  // And the exact lease. A worker told its token, back from a long pause,
  // must not clear a row another worker now holds under a newer lease.
  assert.deepEqual(write.where.leaseUntil, LEASE_UNTIL);
  assert.equal(write.where.status, "scheduled");
  // And nothing may have left: a row holding a request key was dispatched, and
  // a dispatched post's outcome is recorded, not released.
  assert.equal(write.where.providerRequestKey, null);

  const [audit] = seen.audits;
  assert.ok(audit);
  assert.equal(audit.action, MARKETING_S2C_ACTIONS.postClaimReleased);
  assert.equal(
    (audit.metadata as { reason?: string }).reason,
    "worker_shutdown",
  );
});

test("a release that matches nothing says so instead of pretending", async () => {
  const { database, seen } = fakeDatabase({ updates: [0] });
  assert.deepEqual(
    await releaseMarketingPostClaim(asTransaction(database), {
      id: POST_ID,
      claimToken: TOKEN,
      expectedLeaseUntil: LEASE_UNTIL,
    expectedHistoryVersion: 3,
      reason: "no_longer_admitted",
    }),
    { released: false },
  );
  assert.equal(seen.audits.length, 0, "nothing happened, so nothing is recorded");
});

test("a release says why, from a closed list", async () => {
  await assert.rejects(
    releaseMarketingPostClaim(asTransaction(fakeDatabase().database), {
      id: POST_ID,
      claimToken: TOKEN,
      expectedLeaseUntil: LEASE_UNTIL,
    expectedHistoryVersion: 3,
      reason: "because" as never,
    }),
    (error: unknown) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "claim_release_reason_unknown",
  );
  assert.deepEqual([...MARKETING_CLAIM_RELEASE_REASONS], [
    "lease_too_short",
    "no_longer_admitted",
    "worker_shutdown",
    "adapter_unavailable",
  ]);
});

test("the S2c actions are their own two names", () => {
  assert.deepEqual(Object.values(MARKETING_S2C_ACTIONS), [
    "marketing_post.claimed",
    "marketing_post.claim_released",
  ]);
});
