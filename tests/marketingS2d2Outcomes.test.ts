// What became of a dispatched post: the three answers, and only these three.
//
// Contract: the S2 plan's "S2d2", inventory rows 213-216.
//
// The sentence this file is about: **`outcome_unknown` is a result, not an error
// to swallow.** The policy says never blind retry, and it is the value that makes
// a caller stop. Recording it also stops an autonomous account, in the same
// transaction, because the hazard is that something may already be live that
// nothing here can see.

import assert from "node:assert/strict";
import test from "node:test";

import {
  recordMarketingPostFailed,
  recordMarketingPostOutcomeUnknown,
  recordMarketingPostPublished,
  MarketingStoreRefusedError,
  MARKETING_S2D2_ACTIONS,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import {
  MARKETING_PAUSE_REASON_CODES,
  MARKETING_SAFETY_PAUSE_REASON_CODES,
} from "@/lib/marketingAutomationSchema";

const CHANNEL_ID = "chn_linkedin_en";
const POST_ID = "post-dispatched-1";
const REQUEST_KEY = "linkedin/linkedin-1/en/2026-09-23/launch";
const NOW = new Date("2026-09-23T09:00:30.000Z");
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
  status: "publishing",
  providerRequestKey: REQUEST_KEY,
  publishAttempt: 1,
  history: [],
  historyVersion: 4,
  ...overrides,
});

const channelRow = (status = "autonomous_mode") => ({
  id: CHANNEL_ID,
  channel: "linkedin",
  accountSlug: "linkedin-1",
  status,
  connectionGeneration: 1,
  dailyCapOverride: null,
  weeklyCapOverride: null,
  pausedAt: null,
  pausedFromMode: null,
  pauseReasonCode: null,
});

const fakeDatabase = (
  options: {
    post?: PostRow | null;
    channelStatus?: string;
    updates?: number[];
    channelUpdates?: number[];
    isolation?: string;
  } = {},
) => {
  const {
    post = postRow(),
    channelStatus = "autonomous_mode",
    updates = [1],
    channelUpdates = [1],
    isolation = "serializable",
  } = options;
  const seen: {
    posts: Updated[];
    channels: Updated[];
    audits: Record<string, unknown>[];
    sql: string[];
  } = { posts: [], channels: [], audits: [], sql: [] };
  let postUpdate = 0;
  let channelUpdate = 0;
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
      if (sql.includes("providerRequestKey")) return post === null ? [] : [post];
      if (sql.includes("FOR UPDATE")) return [channelRow(channelStatus)];
      throw new Error(`unexpected raw statement: ${sql}`);
    },
    marketingPost: {
      updateMany: async (input: Updated) => {
        seen.posts.push(input);
        const count = updates[postUpdate] ?? 0;
        postUpdate += 1;
        return { count };
      },
    },
    marketingChannel: {
      findUnique: async () => channelRow(channelStatus),
      updateMany: async (input: Updated) => {
        seen.channels.push(input);
        const count = channelUpdates[channelUpdate] ?? 0;
        channelUpdate += 1;
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

const base = { id: POST_ID, requestKey: REQUEST_KEY, expectedHistoryVersion: 4 };

// ---------------------------------------------------------------------------
// published
// ---------------------------------------------------------------------------

test("a published post records the platform's object and the database's clock", async () => {
  const { database, seen } = fakeDatabase();

  const result = await recordMarketingPostPublished(asTransaction(database), {
    ...base,
    externalPostId: EXTERNAL_ID,
    externalUrl: EXTERNAL_URL,
  });

  assert.deepEqual(result, { recorded: true, paused: false });
  const [written] = seen.posts;
  assert.equal(written.data.status, "published");
  assert.equal(written.data.externalPostId, EXTERNAL_ID);
  assert.equal(written.data.externalUrl, EXTERNAL_URL);
  // The database's clock, not the caller's: a published time a caller chose is
  // one a caller could choose to be before its own deadline.
  assert.deepEqual(written.data.publishedAt, NOW);
  assert.equal(written.data.historyVersion, 5);
  // The attempt has concluded, so the claim describes nothing. Left set it would
  // hide a published post behind a dead lease.
  assert.equal(written.data.claimToken, null);
  assert.equal(written.data.leaseUntil, null);
});

test("the attempt entry is appended, strict, and carries no error code", async () => {
  const { database, seen } = fakeDatabase({
    post: postRow({ publishAttempt: 3, history: [] }),
  });
  await recordMarketingPostPublished(asTransaction(database), {
    ...base,
    externalPostId: EXTERNAL_ID,
    externalUrl: EXTERNAL_URL,
  });
  const history = seen.posts[0]?.data.history as Array<Record<string, unknown>>;
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    at: NOW.toISOString(),
    type: "attempt",
    attempt: 3,
    outcome: "published",
    errorCode: null,
  });
});

test("a URL that is not HTTPS is refused before anything is read", async () => {
  // A URL is what a person clicks to check the post exists, and one this system
  // cannot vouch for is worse than none.
  for (const externalUrl of [
    "http://www.linkedin.com/feed/update/1",
    "javascript:alert(1)",
    "not a url",
  ]) {
    const { database, seen } = fakeDatabase();
    await assert.rejects(
      recordMarketingPostPublished(asTransaction(database), {
        ...base,
        externalPostId: EXTERNAL_ID,
        externalUrl,
      }),
      MarketingStoreRefusedError,
      externalUrl,
    );
    assert.deepEqual(seen.sql, [], "nothing is read before the input is checked");
  }
});

test("a published post without an external id is refused", async () => {
  const { database } = fakeDatabase();
  await assert.rejects(
    recordMarketingPostPublished(asTransaction(database), {
      ...base,
      externalPostId: "",
      externalUrl: EXTERNAL_URL,
    }),
    MarketingStoreRefusedError,
  );
});

// ---------------------------------------------------------------------------
// failed
// ---------------------------------------------------------------------------

test("a failed post records the code and releases the claim", async () => {
  const { database, seen } = fakeDatabase();
  const result = await recordMarketingPostFailed(asTransaction(database), {
    ...base,
    errorCode: "platform_rejected_content",
  });
  assert.deepEqual(result, { recorded: true, paused: false });
  const [written] = seen.posts;
  assert.equal(written.data.status, "failed");
  assert.equal(written.data.errorCode, "platform_rejected_content");
  assert.equal(written.data.claimToken, null);
  assert.equal(written.data.leaseUntil, null);
  const history = written.data.history as Array<Record<string, unknown>>;
  assert.equal(history[0]?.outcome, "failed");
  assert.equal(history[0]?.errorCode, "platform_rejected_content");
  // A confirmed failure does not pause anything: the platform answered.
  assert.deepEqual(seen.channels, []);
});

test("a failure with no code is refused", async () => {
  const { database } = fakeDatabase();
  await assert.rejects(
    recordMarketingPostFailed(asTransaction(database), { ...base, errorCode: "" }),
    MarketingStoreRefusedError,
  );
});

// ---------------------------------------------------------------------------
// outcome_unknown, and the pause it carries
// ---------------------------------------------------------------------------

test("an unknown outcome keeps its claim, unlike the two that concluded", async () => {
  // The one state where something may exist on the platform that this system
  // cannot see. Clearing the claim would let the next run treat the row as free.
  const { database, seen } = fakeDatabase();
  const result = await recordMarketingPostOutcomeUnknown(asTransaction(database), {
    ...base,
    errorCode: "request_timed_out",
  });
  assert.deepEqual(result, { recorded: true, paused: true });
  const [written] = seen.posts;
  assert.equal(written.data.status, "outcome_unknown");
  assert.deepEqual(written.data.outcomeUnknownAt, NOW);
  assert.equal(
    "claimToken" in written.data,
    false,
    "an unknown outcome must not release the claim",
  );
  assert.equal("leaseUntil" in written.data, false);
});

test("an unknown outcome stops an autonomous account in the same transaction", async () => {
  const { database, seen } = fakeDatabase({ channelStatus: "autonomous_mode" });
  await recordMarketingPostOutcomeUnknown(asTransaction(database), {
    ...base,
    errorCode: "request_timed_out",
  });
  assert.equal(seen.channels.length, 1);
  const [stopped] = seen.channels;
  assert.equal(stopped.where.status, "autonomous_mode");
  assert.equal(stopped.data.status, "paused");
  assert.equal(stopped.data.pauseReasonCode, "outcome_unknown");
  // The trigger writes these from the transition, so a caller that set them
  // could set them wrongly.
  assert.equal("pausedAt" in stopped.data, false);
  assert.equal("pausedFromMode" in stopped.data, false);
  // And it is its own audit action, because it is its own decision.
  const codes = seen.audits.map((audit) => audit.action);
  assert.ok(codes.includes(MARKETING_S2D2_ACTIONS.accountOutcomeUnknownPaused));
  assert.ok(codes.includes(MARKETING_S2D2_ACTIONS.outcomeUnknown));
});

test("an approval-mode account is not paused by an unknown outcome", async () => {
  // A person is already looking at every post there, which is what pausing
  // would achieve.
  const { database, seen } = fakeDatabase({ channelStatus: "approval_mode" });
  const result = await recordMarketingPostOutcomeUnknown(asTransaction(database), {
    ...base,
    errorCode: "request_timed_out",
  });
  assert.deepEqual(result, { recorded: true, paused: false });
  assert.deepEqual(seen.channels, []);
  assert.equal(
    seen.audits.some(
      (audit) => audit.action === MARKETING_S2D2_ACTIONS.accountOutcomeUnknownPaused,
    ),
    false,
  );
});

test("the safety reason is its own closed list, not an operator reason", async () => {
  // Merging the two lists would let an operator pick "outcome_unknown" from a
  // form -- claiming a safety condition that never happened -- and would let a
  // safety pause read later as somebody requesting one.
  assert.deepEqual(MARKETING_SAFETY_PAUSE_REASON_CODES, ["outcome_unknown"]);
  for (const code of MARKETING_SAFETY_PAUSE_REASON_CODES) {
    assert.equal(
      (MARKETING_PAUSE_REASON_CODES as readonly string[]).includes(code),
      false,
      `${code} must not be an operator reason`,
    );
  }
});

// ---------------------------------------------------------------------------
// What binds an outcome to its attempt
// ---------------------------------------------------------------------------

test("an outcome is bound by the request key, not by a live claim", async () => {
  // A lease can expire after a call has begun -- the plan says so, and says that
  // is never called reconciliation -- so requiring a live claim here would leave
  // the row publishing forever with the answer in hand.
  const { database, seen } = fakeDatabase();
  await recordMarketingPostFailed(asTransaction(database), {
    ...base,
    errorCode: "platform_rejected_content",
  });
  const [written] = seen.posts;
  assert.equal(written.where.providerRequestKey, REQUEST_KEY);
  assert.equal(written.where.status, "publishing");
  assert.equal(written.where.historyVersion, 4);
  assert.equal("claimToken" in written.where, false);
  assert.equal("leaseUntil" in written.where, false);
});

test("every refusal leaves the row alone and writes no audit entry", async () => {
  const cases: Array<[string, Parameters<typeof fakeDatabase>[0], string]> = [
    ["a post that is gone", { post: null }, "post_not_found"],
    ["a post still scheduled", { post: postRow({ status: "scheduled" }) }, "post_not_publishing"],
    ["a post already published", { post: postRow({ status: "published" }) }, "post_not_publishing"],
    [
      "an answer to a different attempt",
      { post: postRow({ providerRequestKey: "some/other/key" }) },
      "request_key_mismatch",
    ],
    ["a history version that moved", { updates: [0] }, "outcome_conflict"],
  ];
  for (const [what, options, reason] of cases) {
    const { database, seen } = fakeDatabase(options);
    const result = await recordMarketingPostFailed(asTransaction(database), {
      ...base,
      errorCode: "platform_rejected_content",
    });
    assert.deepEqual(result, { recorded: false, reason }, what);
    assert.deepEqual(seen.audits, [], `${what}: no audit entry`);
    assert.deepEqual(seen.channels, [], `${what}: no channel write`);
  }
});

test("all three refuse outside a serializable transaction", async () => {
  for (const record of [
    () =>
      recordMarketingPostPublished(asTransaction(fakeDatabase({ isolation: "read committed" }).database), {
        ...base,
        externalPostId: EXTERNAL_ID,
        externalUrl: EXTERNAL_URL,
      }),
    () =>
      recordMarketingPostFailed(asTransaction(fakeDatabase({ isolation: "read committed" }).database), {
        ...base,
        errorCode: "x",
      }),
    () =>
      recordMarketingPostOutcomeUnknown(
        asTransaction(fakeDatabase({ isolation: "read committed" }).database),
        { ...base, errorCode: "x" },
      ),
  ]) {
    await assert.rejects(record(), MarketingStoreRefusedError);
  }
});

test("the audit chain lock comes before the row lock, in all three", async () => {
  for (const record of [
    (database: unknown) =>
      recordMarketingPostPublished(asTransaction(database), {
        ...base,
        externalPostId: EXTERNAL_ID,
        externalUrl: EXTERNAL_URL,
      }),
    (database: unknown) =>
      recordMarketingPostFailed(asTransaction(database), { ...base, errorCode: "x" }),
    (database: unknown) =>
      recordMarketingPostOutcomeUnknown(asTransaction(database), { ...base, errorCode: "x" }),
  ]) {
    const { database, seen } = fakeDatabase();
    await record(database);
    const advisory = seen.sql.findIndex((sql) => /pg_advisory_xact_lock/.test(sql));
    const postLock = seen.sql.findIndex((sql) => sql.includes("providerRequestKey"));
    assert.ok(advisory >= 0 && postLock >= 0);
    assert.ok(advisory < postLock, "the chain lock comes first");
  }
});

test("an empty request key names nothing and is refused", async () => {
  const { database, seen } = fakeDatabase();
  await assert.rejects(
    recordMarketingPostFailed(asTransaction(database), {
      ...base,
      requestKey: "",
      errorCode: "x",
    }),
    MarketingStoreRefusedError,
  );
  assert.deepEqual(seen.sql, []);
});
