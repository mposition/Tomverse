// What a later lookup found, for a post already dispatched.
//
// Contract: the S2 plan's "S2d2", inventory rows 217-219.
//
// The sentence this file exists to hold: **polling never resolves an
// `outcome_unknown`.** A lookup that fails to find an object has not established
// that the object does not exist, and an unknown outcome is precisely the state
// where something may be live that this system cannot see. Only a person moves a
// row out of it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  recordMarketingPostPollRemovedByPlatform,
  recordMarketingPostPollVerified,
  recordMarketingPostPolledPublished,
  MarketingStoreRefusedError,
  MARKETING_S2D2_ACTIONS,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import {
  MARKETING_REMOVAL_EVIDENCE,
  MARKETING_VERIFICATION_METHODS,
} from "@/lib/marketingAutomationSchema";

const CHANNEL_ID = "chn_linkedin_en";
const POST_ID = "post-live-1";
const REQUEST_KEY = "linkedin/linkedin-1/en/2026-09-23/launch";
const NOW = new Date("2026-09-24T09:00:00.000Z");
const EXTERNAL_ID = "urn:li:share:7100";
const EXTERNAL_URL = "https://www.linkedin.com/feed/update/urn:li:share:7100";

const asTransaction = (database: unknown): MarketingTransaction =>
  database as MarketingTransaction;

const statementText = (query: unknown): string => {
  if (Array.isArray(query)) return query.join("?");
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

type Updated = { where: Record<string, unknown>; data: Record<string, unknown> };

type PostRow = {
  id: string;
  channelId: string;
  status: string;
  providerRequestKey: string | null;
  publishAttempt: number;
  history: unknown;
  historyVersion: number;
};

const postRow = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: POST_ID,
  channelId: CHANNEL_ID,
  status: "published",
  providerRequestKey: REQUEST_KEY,
  publishAttempt: 1,
  history: [],
  historyVersion: 6,
  ...overrides,
});

const fakeDatabase = (
  options: {
    post?: PostRow | null;
    updates?: number[];
    isolation?: string;
  } = {},
) => {
  const { post = postRow(), updates = [1], isolation = "serializable" } = options;
  const seen: {
    posts: Updated[];
    channels: Updated[];
    audits: Record<string, unknown>[];
    sql: string[];
  } = { posts: [], channels: [], audits: [], sql: [] };
  let update = 0;
  const database = {
    async $executeRaw(query: unknown) {
      seen.sql.push(statementText(query));
      return 0;
    },
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      seen.sql.push(sql);
      if (sql.includes("transaction_isolation")) return [{ level: isolation }];
      if (sql.includes("clock_timestamp")) return [{ now: NOW, createdAt: NOW }];
      if (sql.includes("MarketingPost")) return post === null ? [] : [post];
      throw new Error(`unexpected raw statement: ${sql}`);
    },
    marketingPost: {
      updateMany: async (input: Updated) => {
        seen.posts.push(input);
        const count = updates[update] ?? 0;
        update += 1;
        return { count };
      },
    },
    marketingChannel: {
      updateMany: async (input: Updated) => {
        seen.channels.push(input);
        return { count: 1 };
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

// ---------------------------------------------------------------------------
// poll_published — the dispatch's answer, arriving late
// ---------------------------------------------------------------------------

test("a poll that finds the object writes exactly what a direct success writes", async () => {
  // The plan says "the same exact published fields and strict published-attempt
  // append as direct success". Sharing the writer is what makes that true by
  // construction, rather than by two lists agreeing on the day they were written.
  const { database, seen } = fakeDatabase({ post: postRow({ status: "publishing" }) });

  const result = await recordMarketingPostPolledPublished(asTransaction(database), {
    id: POST_ID,
    requestKey: REQUEST_KEY,
    expectedHistoryVersion: 6,
    externalPostId: EXTERNAL_ID,
    externalUrl: EXTERNAL_URL,
  });

  assert.deepEqual(result, { recorded: true, paused: false });
  const [written] = seen.posts;
  assert.equal(written.data.status, "published");
  assert.equal(written.data.externalPostId, EXTERNAL_ID);
  assert.equal(written.data.externalUrl, EXTERNAL_URL);
  assert.deepEqual(written.data.publishedAt, NOW);
  assert.equal(written.data.historyVersion, 7);
  assert.equal(written.data.claimToken, null);
  const history = written.data.history as Array<Record<string, unknown>>;
  assert.deepEqual(history[0], {
    at: NOW.toISOString(),
    type: "attempt",
    attempt: 1,
    outcome: "published",
    errorCode: null,
  });
  // Its own action, because how we learned it is part of the record.
  assert.equal(seen.audits[0]?.action, MARKETING_S2D2_ACTIONS.pollPublished);
  assert.equal(seen.audits[0]?.action, "marketing_post.poll_published");
});

test("a poll only answers a publishing row", async () => {
  // A `published` row is already answered; an `outcome_unknown` row is a person's
  // to resolve and polling must not touch it.
  for (const status of ["published", "outcome_unknown", "failed", "scheduled"]) {
    const { database, seen } = fakeDatabase({ post: postRow({ status }) });
    const result = await recordMarketingPostPolledPublished(asTransaction(database), {
      id: POST_ID,
      requestKey: REQUEST_KEY,
      expectedHistoryVersion: 6,
      externalPostId: EXTERNAL_ID,
      externalUrl: EXTERNAL_URL,
    });
    assert.deepEqual(result, { recorded: false, reason: "post_not_publishing" }, status);
    assert.deepEqual(seen.posts, [], status);
    assert.deepEqual(seen.audits, [], status);
  }
});

// ---------------------------------------------------------------------------
// poll_verified
// ---------------------------------------------------------------------------

test("verification transitions published to verified and leaves history alone", async () => {
  const { database, seen } = fakeDatabase();

  const result = await recordMarketingPostPollVerified(asTransaction(database), {
    id: POST_ID,
    expectedHistoryVersion: 6,
    verificationMethod: "status_query",
  });

  assert.deepEqual(result, { recorded: true });
  const [written] = seen.posts;
  assert.equal(written.data.status, "verified");
  assert.deepEqual(written.data.verifiedPublicAt, NOW);
  assert.equal(written.data.verificationMethod, "status_query");
  // Verification is not an attempt. Appending to history would make the array say
  // a fourth thing happened to the post when nothing was sent.
  assert.equal("history" in written.data, false);
  assert.equal("historyVersion" in written.data, false);
  // But the version is still the predicate, so a concurrent edit loses.
  assert.equal(written.where.historyVersion, 6);
  assert.equal(written.where.status, "published");
  assert.equal(seen.audits[0]?.action, "marketing_post.poll_verified");
});

test("only a published row can be verified", async () => {
  for (const status of ["verified", "publishing", "outcome_unknown", "removed_by_platform"]) {
    const { database, seen } = fakeDatabase({ post: postRow({ status }) });
    const result = await recordMarketingPostPollVerified(asTransaction(database), {
      id: POST_ID,
      expectedHistoryVersion: 6,
      verificationMethod: "status_query",
    });
    assert.deepEqual(result, { recorded: false, reason: "post_not_published" }, status);
    assert.deepEqual(seen.posts, [], status);
  }
});

test("a verification method outside the closed list is refused", async () => {
  const { database, seen } = fakeDatabase();
  await assert.rejects(
    recordMarketingPostPollVerified(asTransaction(database), {
      id: POST_ID,
      expectedHistoryVersion: 6,
      verificationMethod: "vibes" as never,
    }),
    MarketingStoreRefusedError,
  );
  assert.deepEqual(seen.sql, []);
  // The list is also a database CHECK, so the two have to agree.
  assert.deepEqual(
    [...MARKETING_VERIFICATION_METHODS],
    ["status_query", "webhook", "operator_sample"],
  );
});

// ---------------------------------------------------------------------------
// poll_removed_by_platform
// ---------------------------------------------------------------------------

test("a platform removal transitions from either live status, history untouched", async () => {
  for (const from of ["published", "verified"] as const) {
    const { database, seen } = fakeDatabase({ post: postRow({ status: from }) });
    const result = await recordMarketingPostPollRemovedByPlatform(asTransaction(database), {
      id: POST_ID,
      expectedHistoryVersion: 6,
      evidence: "status_query_not_found",
    });
    assert.deepEqual(result, { recorded: true, from });
    const [written] = seen.posts;
    assert.equal(written.data.status, "removed_by_platform");
    assert.equal(written.where.status, from);
    assert.equal("history" in written.data, false);
    assert.equal("historyVersion" in written.data, false);
    // Not a deletion. A deletion is something this system did, with a
    // `deletedAt` and a `deletionMethod`; conflating them would let retention
    // read a platform takedown as evidence we had already retracted the post.
    assert.equal("deletedAt" in written.data, false);
    assert.equal("deletionMethod" in written.data, false);
  }
});

test("the removal's evidence goes in the audit entry, not on the row", async () => {
  const { database, seen } = fakeDatabase();
  await recordMarketingPostPollRemovedByPlatform(asTransaction(database), {
    id: POST_ID,
    expectedHistoryVersion: 6,
    evidence: "status_query_reports_removed",
  });
  const [written] = seen.posts;
  assert.equal("evidence" in written.data, false);
  const audit = seen.audits.find(
    (entry) => entry.action === MARKETING_S2D2_ACTIONS.pollRemovedByPlatform,
  );
  assert.equal((audit?.metadata as Record<string, unknown>).evidence, "status_query_reports_removed");
  assert.equal((audit?.metadata as Record<string, unknown>).fromStatus, "published");
});

test("the two evidence values stay distinct", async () => {
  // A lookup that cannot find something has not established that the platform
  // took it down, and an operator reading the record later needs to know which
  // was observed. Collapsing them would throw that away.
  assert.deepEqual(
    [...MARKETING_REMOVAL_EVIDENCE],
    ["status_query_not_found", "status_query_reports_removed"],
  );
  const { database } = fakeDatabase();
  await assert.rejects(
    recordMarketingPostPollRemovedByPlatform(asTransaction(database), {
      id: POST_ID,
      expectedHistoryVersion: 6,
      evidence: "gone" as never,
    }),
    MarketingStoreRefusedError,
  );
});

test("a row that is not live cannot be removed by the platform", async () => {
  for (const status of ["publishing", "scheduled", "outcome_unknown", "deleted"]) {
    const { database, seen } = fakeDatabase({ post: postRow({ status }) });
    const result = await recordMarketingPostPollRemovedByPlatform(asTransaction(database), {
      id: POST_ID,
      expectedHistoryVersion: 6,
      evidence: "status_query_not_found",
    });
    assert.deepEqual(result, { recorded: false, reason: "post_not_live" }, status);
    assert.deepEqual(seen.posts, [], status);
  }
});

// ---------------------------------------------------------------------------
// Shared contracts
// ---------------------------------------------------------------------------

test("all three refuse outside a serializable transaction", async () => {
  const cases = [
    () =>
      recordMarketingPostPollVerified(
        asTransaction(fakeDatabase({ isolation: "read committed" }).database),
        { id: POST_ID, expectedHistoryVersion: 6, verificationMethod: "status_query" },
      ),
    () =>
      recordMarketingPostPollRemovedByPlatform(
        asTransaction(fakeDatabase({ isolation: "read committed" }).database),
        { id: POST_ID, expectedHistoryVersion: 6, evidence: "status_query_not_found" },
      ),
  ];
  for (const record of cases) {
    await assert.rejects(record(), MarketingStoreRefusedError);
  }
});

test("a history version that moved loses, and writes nothing", async () => {
  for (const record of [
    (database: unknown) =>
      recordMarketingPostPollVerified(asTransaction(database), {
        id: POST_ID,
        expectedHistoryVersion: 6,
        verificationMethod: "status_query",
      }),
    (database: unknown) =>
      recordMarketingPostPollRemovedByPlatform(asTransaction(database), {
        id: POST_ID,
        expectedHistoryVersion: 6,
        evidence: "status_query_not_found",
      }),
  ]) {
    const { database, seen } = fakeDatabase({ updates: [0] });
    const result = await record(database);
    assert.equal((result as { recorded: boolean }).recorded, false);
    assert.deepEqual(seen.audits, []);
  }
});

test("a post that is gone is not found", async () => {
  const { database } = fakeDatabase({ post: null });
  assert.deepEqual(
    await recordMarketingPostPollVerified(asTransaction(database), {
      id: POST_ID,
      expectedHistoryVersion: 6,
      verificationMethod: "status_query",
    }),
    { recorded: false, reason: "post_not_found" },
  );
});

test("the audit chain lock comes before the row lock", async () => {
  const { database, seen } = fakeDatabase();
  await recordMarketingPostPollVerified(asTransaction(database), {
    id: POST_ID,
    expectedHistoryVersion: 6,
    verificationMethod: "status_query",
  });
  const advisory = seen.sql.findIndex((sql) => /pg_advisory_xact_lock/.test(sql));
  const rowLock = seen.sql.findIndex((sql) => sql.includes("MarketingPost"));
  assert.ok(advisory >= 0 && rowLock >= 0);
  assert.ok(advisory < rowLock);
});
