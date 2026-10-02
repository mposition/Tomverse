// The last thing that happens before a post leaves this system.
//
// Contract: the S2 plan's "S2d2 — real adapter, dispatch, polling and unknown
// outcome", and the inventory row for `marketing_post.dispatch_started`.
//
// The one sentence everything here is about: **a dispatch is the transition
// that says a request is about to leave, written and committed before it does.**
// A process that dies between the request leaving and the answer arriving leaves
// no trace of its own, so what says an attempt was made is this row and this
// audit entry. Without them the next run sees a `scheduled` post with a stale
// claim and no evidence anything was sent, and posts it again.
//
// TypeScript and the `@/` alias for the reason
// `tests/marketingS2b2AutonomousInsert.test.ts` gives: a module reached by two
// specifier forms is loaded twice, and this file shares the store with that one.

import assert from "node:assert/strict";
import test from "node:test";

import {
  startMarketingPostDispatch,
  MarketingStoreRefusedError,
  MARKETING_S2D2_ACTIONS,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import { MARKETING_POST_AUDIT_TARGET_TYPE } from "@/lib/marketingAuditEvidence";

import {
  auditEvidenceReads,
  hashedSystemAuditRow,
  configureTestAuditIntegrityKey,
  type StoredAuditRow,
} from "./support/hashedAuditEntry";

configureTestAuditIntegrityKey();

const CHANNEL_ID = "chn_linkedin_en";
const POST_ID = "post-due-1";
const LOGICAL_KEY = "linkedin/linkedin-1/en/2026-09-23/launch";
const TOKEN = "worker-1:attempt-1";
const NOW = new Date("2026-09-23T09:00:00.000Z");
const LEASE_UNTIL = new Date("2026-09-23T09:15:00.000Z");
/** Four minutes ahead of NOW, as the run's deadline is. */
const DEADLINE = new Date("2026-09-23T09:04:00.000Z");
const CALL_BUDGET_MS = 30_000;

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
  logicalKey: string;
  status: string;
  claimToken: string | null;
  leaseUntil: Date | null;
  historyVersion: number;
  publishAttempt: number;
  envelope: unknown;
  mode: string;
  envelopeDigest: string;
  approvedDigest: string | null;
  approvedAt: Date | null;
  approvalExpiresAt: Date | null;
};

const RENDERED_TEXT = "Three answers to one question, side by side.";

/**
 * A real envelope, of the shape the approval digested.
 *
 * The dispatch now returns the payload it locked, parsed with the envelope schema,
 * and refuses a row whose envelope does not parse. The fake used to carry no
 * envelope at all, which was harmless while nothing read it and is exactly the
 * kind of gap a fake should not hide once something does.
 */
const ENVELOPE = {
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: RENDERED_TEXT,
  claimIds: ["claim.compare"],
  assets: [{ assetId: "asset.hero", altKey: "alt.hero" }],
  finalUrl: null,
  scheduledAt: "2026-09-23T09:00:00.000Z",
  disclosureFlags: [],
};

const postRow = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: POST_ID,
  channelId: CHANNEL_ID,
  logicalKey: LOGICAL_KEY,
  status: "scheduled",
  claimToken: TOKEN,
  leaseUntil: LEASE_UNTIL,
  historyVersion: 4,
  publishAttempt: 0,
  envelope: ENVELOPE,
  // An approved post, approved for these bytes and not yet expired: the
  // ordinary case. The autonomous and expired cases override these.
  mode: "approval",
  envelopeDigest: "digest-1",
  approvedDigest: "digest-1",
  approvedAt: new Date("2026-09-22T09:00:00.000Z"),
  approvalExpiresAt: new Date("2026-09-30T09:00:00.000Z"),
  ...overrides,
});

type ChannelRow = {
  id: string;
  channel: string;
  accountSlug: string;
  status: string;
  connectionGeneration: number;
  dailyCapOverride: number | null;
  weeklyCapOverride: number | null;
  externalAccountRef: string | null;
};

const channelRow = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
  id: CHANNEL_ID,
  channel: "linkedin",
  accountSlug: "linkedin-1",
  status: "autonomous_mode",
  connectionGeneration: 1,
  dailyCapOverride: null,
  weeklyCapOverride: null,
  externalAccountRef: "acct_9",
  ...overrides,
});

/**
 * A database that answers the dispatch path's questions.
 *
 * Dispatched on what each statement says, and it throws on one it does not
 * recognise -- so a new read in the store fails this file rather than silently
 * receiving `undefined`. The post lock is matched before the channel lock
 * because both end in `FOR UPDATE`, and the post's is the one that names
 * `logicalKey`.
 */
const fakeDatabase = (
  options: {
    post?: PostRow | null;
    channel?: ChannelRow | null;
    updates?: number[];
    now?: Date;
    isolation?: string;
    /**
     * The autonomous insert's audit metadata, as the dispatch reads it back --
     * wrapped in a row hashed with the real function, so the dispatch's
     * evidence check passes only where it would against the database.
     */
    scheduledMetadata?: Record<string, unknown> | null;
    /** A whole stored row, when a test needs one that is not evidence. */
    scheduledRow?: StoredAuditRow | null;
  } = {},
) => {
  const {
    post = postRow(),
    channel = channelRow(),
    updates = [1],
    now = NOW,
    isolation = "serializable",
  } = options;
  const seen: {
    updates: Updated[];
    audits: Record<string, unknown>[];
    sql: string[];
  } = { updates: [], audits: [], sql: [] };
  let update = 0;
  const database = {
    async $executeRaw(query: unknown) {
      // Recorded too: the audit chain lock is taken with $executeRaw, and a
      // fake that dropped it could not tell whether it had been taken at all.
      seen.sql.push(statementText(query));
      return 0;
    },
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      seen.sql.push(sql);
      if (sql.includes("transaction_isolation")) return [{ level: isolation }];
      if (sql.includes("clock_timestamp")) return [{ now, createdAt: now }];
      if (sql.includes("logicalKey")) return post === null ? [] : [post];
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
      // Two readers: the chain's own tail lookup, and the dispatch reading the
      // autonomous insert's entry back. Told apart by what they ask for.
      findFirst: async (args?: never) => {
        const scheduled =
          options.scheduledRow !== undefined
            ? options.scheduledRow
            : options.scheduledMetadata === undefined || options.scheduledMetadata === null
              ? null
              : hashedSystemAuditRow({
                  action: "marketing_post.autonomous_scheduled",
                  systemActor: "marketing-guard",
                  targetType: MARKETING_POST_AUDIT_TARGET_TYPE,
                  targetId: POST_ID,
                  metadata: options.scheduledMetadata,
                });
        const answer = auditEvidenceReads(scheduled)(args);
        // Anything the evidence reads do not claim is the chain's own tail
        // lookup, which this fake answers with no tail.
        return answer === undefined ? null : answer;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seen.audits.push(data);
        return data;
      },
    },
  };
  return { database, seen };
};

const PROVENANCE = {
  admissionCodeDigest: "code-digest-1",
  configGeneration: 3,
  deploymentId: "deploy-1",
};

const admits = async () => ({ publish: true, ...PROVENANCE });

const dispatch = (
  database: unknown,
  overrides: Partial<Parameters<typeof startMarketingPostDispatch>[1]> = {},
) =>
  startMarketingPostDispatch(asTransaction(database), {
    id: POST_ID,
    claimToken: TOKEN,
    expectedLeaseUntil: LEASE_UNTIL,
    expectedHistoryVersion: 4,
    runDeadlineAt: DEADLINE,
    callBudgetMs: CALL_BUDGET_MS,
    resolveAdmission: admits,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// What a dispatch writes
// ---------------------------------------------------------------------------

test("a dispatch moves the post to publishing and sets its own request key", async () => {
  const { database, seen } = fakeDatabase();

  const result = await dispatch(database);

  assert.deepEqual(result, {
    started: true,
    requestKey: LOGICAL_KEY,
    attempt: 1,
    approvalExpiresAt: new Date("2026-09-30T09:00:00.000Z"),
    payload: {
      channel: "linkedin",
      externalAccountRef: "acct_9",
      locale: "en",
      renderedText: RENDERED_TEXT,
      assetIds: ["asset.hero"],
      finalUrl: null,
    },
  });
  assert.equal(seen.updates.length, 1);
  const [written] = seen.updates;
  // The transition is whitelisted in one direction, and the predicate binds
  // everything the decision was made against.
  assert.equal(written.data.status, "publishing");
  assert.equal(written.where.status, "scheduled");
  assert.equal(written.where.claimToken, TOKEN);
  assert.deepEqual(written.where.leaseUntil, LEASE_UNTIL);
  assert.equal(written.where.historyVersion, 4);
  assert.equal(written.where.deletedAt, null);
  assert.equal(written.where.contentPurgedAt, null);
  // The request key is the post's own logical key, which is unique in the
  // database. Not a value this call invents: a recovery has to be able to ask
  // the platform about the exact key that was sent, and it can only know a key
  // the post already had.
  assert.equal(written.data.providerRequestKey, LOGICAL_KEY);
  assert.equal(written.data.publishAttempt, 1);
});

test("history does not move, and nothing about the outcome is written yet", async () => {
  // The plan is explicit that this transition leaves history alone: a dispatch
  // is not an outcome, and the attempt entry belongs to whichever of published,
  // failed or outcome_unknown follows.
  const { database, seen } = fakeDatabase();
  await dispatch(database);
  const [written] = seen.updates;
  for (const field of [
    "history",
    "historyVersion",
    "externalPostId",
    "externalUrl",
    "publishedAt",
    "outcomeUnknownAt",
    "errorCode",
    "slotDate",
    "claimToken",
    "leaseUntil",
  ]) {
    assert.equal(
      field in written.data,
      false,
      `a dispatch must not write ${field}`,
    );
  }
  // Exactly three fields, so a new one has to be added deliberately.
  assert.deepEqual(Object.keys(written.data).sort(), [
    "providerRequestKey",
    "publishAttempt",
    "status",
  ]);
});

test("the attempt count is the old one plus one, not a fixed 1", async () => {
  // A requeued post has attempted before, and its second attempt has to be
  // distinguishable from its first in the record.
  const { database, seen } = fakeDatabase({ post: postRow({ publishAttempt: 2 }) });
  const result = await dispatch(database);
  assert.equal(result.started, true);
  if (result.started) {
    assert.equal(result.requestKey, LOGICAL_KEY);
    assert.equal(result.attempt, 3);
  }
  assert.equal(seen.updates[0]?.data.publishAttempt, 3);
});

test("the audit entry is written, names the action exactly, and carries the key", async () => {
  const { database, seen } = fakeDatabase();
  await dispatch(database);
  assert.equal(seen.audits.length, 1);
  const [audit] = seen.audits;
  assert.equal(audit.action, MARKETING_S2D2_ACTIONS.dispatchStarted);
  assert.equal(audit.action, "marketing_post.dispatch_started");
  assert.equal(audit.targetType, "MarketingPost");
  assert.equal(audit.targetId, POST_ID);
  const metadata = audit.metadata as Record<string, unknown>;
  // What a recovery needs in order to ask the platform what happened.
  assert.equal(metadata.requestKey, LOGICAL_KEY);
  assert.equal(metadata.attempt, 1);
  assert.equal(metadata.claimToken, TOKEN);
  assert.equal(metadata.runDeadlineAt, DEADLINE.toISOString());
});

// ---------------------------------------------------------------------------
// What stops a dispatch, with nothing sent
// ---------------------------------------------------------------------------

test("every refusal leaves the row alone and writes no audit entry", async () => {
  // The whole point of the refusal list: the caller has to be able to tell
  // "nothing left this process" from "something left and we do not know what
  // happened". The second is not a refusal.
  const cases: Array<[string, Parameters<typeof fakeDatabase>[0], string]> = [
    ["a post that is gone", { post: null }, "post_not_found"],
    ["a post already publishing", { post: postRow({ status: "publishing" }) }, "post_not_scheduled"],
    ["a post already published", { post: postRow({ status: "published" }) }, "post_not_scheduled"],
    ["somebody else's claim", { post: postRow({ claimToken: "worker-2:attempt-9" }) }, "claim_not_held"],
    ["no claim at all", { post: postRow({ claimToken: null }) }, "claim_not_held"],
    ["a channel that is not publishing", { channel: channelRow({ status: "paused" }) }, "channel_not_publishing"],
    ["a history version that moved", { updates: [0] }, "dispatch_conflict"],
  ];
  for (const [what, options, reason] of cases) {
    const { database, seen } = fakeDatabase(options);
    const result = await dispatch(database);
    assert.deepEqual(result, { started: false, reason }, what);
    assert.deepEqual(seen.audits, [], `${what}: no audit entry`);
    if (reason !== "dispatch_conflict") {
      assert.deepEqual(seen.updates, [], `${what}: no write`);
    }
  }
});

test("a post whose channel row is gone is a broken invariant, not a refusal", async () => {
  // Not in the refusal list on purpose. Every refusal above means the world is
  // busy or the caller is behind; a scheduled post pointing at a channel that
  // does not exist means something deleted a row that a foreign key should have
  // held, and answering "not publishing" would file that under normal.
  const { database, seen } = fakeDatabase({ channel: null });
  await assert.rejects(dispatch(database), MarketingStoreRefusedError);
  assert.deepEqual(seen.updates, []);
  assert.deepEqual(seen.audits, []);
});

test("a lease renewed under the same token is somebody else's dispatch", async () => {
  // The token alone is not enough. A worker can pause, have its lease expire,
  // something renew it, and then come back believing it still holds the row.
  // Binding the exact instant makes that dispatch match nothing.
  const { database, seen } = fakeDatabase({
    post: postRow({ leaseUntil: new Date("2026-09-23T09:20:00.000Z") }),
  });
  const result = await dispatch(database);
  assert.deepEqual(result, { started: false, reason: "claim_not_held" });
  assert.deepEqual(seen.updates, []);
});

test("an expired lease is not a licence to publish", async () => {
  // Held, by us, and already run out. Nobody else has it, so it is not a
  // conflict -- but the lease is what says this worker is still entitled to
  // post, and it is not.
  const { database, seen } = fakeDatabase({
    post: postRow({ leaseUntil: new Date("2026-09-23T08:59:00.000Z") }),
  });
  const result = await dispatch(database, {
    expectedLeaseUntil: new Date("2026-09-23T08:59:00.000Z"),
  });
  assert.deepEqual(result, { started: false, reason: "claim_expired" });
  assert.deepEqual(seen.updates, []);
});

test("the resolver is re-run here, and its no stops the dispatch", async () => {
  // The claim's answer is not carried. An account can be paused, a connection
  // rotated and a channel's health go stale between the claim and the call.
  let asked = 0;
  const { database, seen } = fakeDatabase();
  const result = await dispatch(database, {
    resolveAdmission: async () => {
      asked += 1;
      return { publish: false };
    },
  });
  assert.equal(asked, 1, "the resolver must actually be run");
  assert.deepEqual(result, { started: false, reason: "not_admitted" });
  assert.deepEqual(seen.updates, []);
  assert.deepEqual(seen.audits, []);
});

test("the resolver is given the locked channel, not the caller's idea of it", async () => {
  let given: unknown = null;
  const { database } = fakeDatabase({
    channel: channelRow({ status: "approval_mode", connectionGeneration: 7 }),
  });
  await dispatch(database, {
    resolveAdmission: async (_database, channel) => {
      given = channel;
      return { publish: true };
    },
  });
  assert.deepEqual(given, {
    id: CHANNEL_ID,
    channel: "linkedin",
    status: "approval_mode",
    connectionGeneration: 7,
  });
});

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

test("a dispatch with no time left for the call does not begin one", async () => {
  // A call that will be killed mid-flight produces an outcome nobody knows, and
  // a human has to decide what happened. Refusing costs a five-minute wait.
  const { database, seen } = fakeDatabase({ now: new Date("2026-09-23T09:03:45.000Z") });
  const result = await dispatch(database);
  assert.deepEqual(result, { started: false, reason: "deadline_too_close" });
  assert.deepEqual(seen.updates, []);
  assert.deepEqual(seen.audits, []);
  // Refused before the row was even read: there is no point locking anything.
  assert.equal(
    seen.sql.some((sql) => sql.includes("logicalKey")),
    false,
  );
});

test("exactly enough time is enough, and a millisecond less is not", async () => {
  const exact = new Date(DEADLINE.getTime() - CALL_BUDGET_MS);
  const short = new Date(DEADLINE.getTime() - CALL_BUDGET_MS + 1);
  const { database: ok } = fakeDatabase({ now: exact });
  assert.equal((await dispatch(ok)).started, true);
  const { database: tooLate } = fakeDatabase({ now: short });
  assert.deepEqual(await dispatch(tooLate), {
    started: false,
    reason: "deadline_too_close",
  });
});

test("the deadline is measured on the database's clock", async () => {
  // Every other decision in this transaction is made against the database's
  // clock, and mixing in the process's means the refusal and the supervisor's
  // kill disagree about when now was. A fake clock far in the past proves which
  // one is being read.
  const { database, seen } = fakeDatabase({ now: new Date("2020-01-01T00:00:00.000Z") });
  const result = await dispatch(database);
  assert.equal(result.started, true, "a database clock with time to spare proceeds");
  assert.ok(seen.sql.some((sql) => sql.includes("clock_timestamp")));
});

// ---------------------------------------------------------------------------
// The transaction it has to be in
// ---------------------------------------------------------------------------

test("a dispatch refuses outside a serializable transaction", async () => {
  const { database, seen } = fakeDatabase({ isolation: "read committed" });
  await assert.rejects(dispatch(database), MarketingStoreRefusedError);
  assert.deepEqual(seen.updates, []);
  assert.deepEqual(seen.audits, []);
});

test("the audit chain lock is taken before any row lock", async () => {
  // The admin paths take it first, and taking the two in the other order is how
  // two of them deadlock.
  const { database, seen } = fakeDatabase();
  await dispatch(database);
  const advisory = seen.sql.findIndex((sql) => /pg_advisory_xact_lock/.test(sql));
  const postLock = seen.sql.findIndex((sql) => sql.includes("logicalKey"));
  assert.ok(advisory >= 0, "the chain lock must be taken");
  assert.ok(postLock >= 0, "the post must be locked");
  assert.ok(advisory < postLock, "the chain lock comes first");
});

test("a caller that supplies nonsense is refused before anything is read", async () => {
  for (const overrides of [
    { claimToken: "" },
    { expectedLeaseUntil: new Date(Number.NaN) },
    { runDeadlineAt: new Date(Number.NaN) },
    { callBudgetMs: 0 },
    { callBudgetMs: -1 },
  ] as Array<Partial<Parameters<typeof startMarketingPostDispatch>[1]>>) {
    const { database, seen } = fakeDatabase();
    await assert.rejects(dispatch(database, overrides), MarketingStoreRefusedError);
    assert.deepEqual(seen.sql, [], "nothing is read before the input is checked");
  }
});

test("the payload is the locked envelope's, sent byte for byte", async () => {
  // What is sent is what was locked: returned from the same row lock the
  // transition took, rather than read afterwards in another transaction where an
  // edit could have landed. Nothing is added to the text -- anything added would
  // be bytes the approval did not cover.
  const text = "A sentence with a trailing space and an emoji 🚀 ";
  const { database } = fakeDatabase({
    post: postRow({ envelope: { ...ENVELOPE, renderedText: text } }),
  });
  const result = await dispatch(database);
  assert.equal(result.started, true);
  if (result.started) {
    assert.equal(result.payload.renderedText, text);
  }
});

test("a row whose envelope no longer parses is not one this can say it is sending", async () => {
  const { database } = fakeDatabase({
    post: postRow({ envelope: { ...ENVELOPE, renderedText: "" } }),
  });
  await assert.rejects(dispatch(database));
});

test("a malformed envelope is refused before the post moves or anything is audited", async () => {
  // Refused without moving the post or writing an audit entry, rather than undone
  // afterwards by the transaction rolling back. The difference matters for the
  // audit chain lock, which a late refusal would hold for nothing.
  const { database, seen } = fakeDatabase({
    post: postRow({ envelope: { ...ENVELOPE, renderedText: "" } }),
  });
  await assert.rejects(dispatch(database));
  assert.deepEqual(seen.updates, [], "the post did not move");
  assert.deepEqual(seen.audits, [], "nothing was audited");
});

// ---------------------------------------------------------------------------
// What was approved, and what an autonomous post was admitted under
// ---------------------------------------------------------------------------

test("an approval that has expired, or covers other bytes, does not send", async () => {
  for (const overrides of [
    { approvalExpiresAt: new Date(NOW.getTime() - 1) },
    { approvalExpiresAt: NOW },
    { approvalExpiresAt: null },
    { approvedDigest: "digest-0" },
    { approvedDigest: null },
    { approvedAt: null },
  ]) {
    const { database, seen } = fakeDatabase({ post: postRow(overrides) });
    assert.deepEqual(
      await dispatch(database),
      { started: false, reason: "approval_not_current" },
      JSON.stringify(overrides),
    );
    assert.equal(seen.updates.length, 0);
    assert.equal(seen.audits.length, 0);
  }
});

test("an autonomous post goes out under the provenance it was admitted with", async () => {
  const { database } = fakeDatabase({
    post: postRow({ mode: "autonomous", approvedDigest: null, approvedAt: null, approvalExpiresAt: null }),
    scheduledMetadata: { ...PROVENANCE, commitSha: "abc" },
  });
  const result = await dispatch(database);
  assert.equal(result.started, true);
});

test("an autonomous post admitted under another build, generation or deployment does not", async () => {
  for (const changed of [
    { admissionCodeDigest: "code-digest-0" },
    { configGeneration: 2 },
    { deploymentId: "deploy-0" },
    { deploymentId: "" },
  ]) {
    const { database, seen } = fakeDatabase({
      post: postRow({ mode: "autonomous" }),
      scheduledMetadata: { ...PROVENANCE, ...changed },
    });
    assert.deepEqual(
      await dispatch(database),
      { started: false, reason: "provenance_changed" },
      JSON.stringify(changed),
    );
    assert.equal(seen.updates.length, 0);
  }
  // No recorded admission at all is not a match either.
  const { database } = fakeDatabase({ post: postRow({ mode: "autonomous" }), scheduledMetadata: null });
  assert.deepEqual(await dispatch(database), { started: false, reason: "provenance_changed" });
});

test("an autonomous post on an account moved back to approval mode does not go out", async () => {
  const { database } = fakeDatabase({
    post: postRow({ mode: "autonomous" }),
    channel: channelRow({ status: "approval_mode" }),
    scheduledMetadata: PROVENANCE,
  });
  assert.deepEqual(await dispatch(database), { started: false, reason: "not_admitted" });
});

test("the resolver is told the post's mode", async () => {
  const modes: string[] = [];
  const { database } = fakeDatabase({ post: postRow({ mode: "autonomous" }), scheduledMetadata: PROVENANCE });
  await dispatch(database, {
    resolveAdmission: async (_database, _channel, postMode) => {
      modes.push(postMode);
      return { publish: true, ...PROVENANCE };
    },
  });
  assert.deepEqual(modes, ["autonomous"]);
});

test("the deadline is judged again after the locks and the resolver", async () => {
  // Enough time at the start; not by the time the resolver has answered. The
  // resolver's clock is the later one, and it is the one that decides.
  const { database, seen } = fakeDatabase();
  const result = await dispatch(database, {
    resolveAdmission: async () => ({
      publish: true,
      ...PROVENANCE,
      checkedAt: new Date(DEADLINE.getTime() - CALL_BUDGET_MS + 1),
    }),
  });
  assert.deepEqual(result, { started: false, reason: "deadline_too_close" });
  assert.equal(seen.updates.length, 0);

  // And a resolver cannot move the check earlier than the store's own clock.
  const late = fakeDatabase({ now: new Date(DEADLINE.getTime() - CALL_BUDGET_MS + 1) });
  assert.deepEqual(
    await dispatch(late.database, {
      resolveAdmission: async () => ({ publish: true, ...PROVENANCE, checkedAt: new Date(0) }),
    }),
    { started: false, reason: "deadline_too_close" },
  );
});

test("an autonomous post whose scheduling record is not evidence does not go out", async () => {
  // Right values, wrong row: the round-2 review's case. Each is refused even
  // though the metadata matches the resolver exactly.
  const scheduled = (overrides: Partial<StoredAuditRow>, actor = "marketing-guard") =>
    hashedSystemAuditRow(
      {
        action: "marketing_post.autonomous_scheduled",
        systemActor: actor,
        targetType: MARKETING_POST_AUDIT_TARGET_TYPE,
        targetId: POST_ID,
        metadata: PROVENANCE,
      },
      overrides,
    );
  for (const [label, row] of [
    ["unhashed", { ...scheduled({}), entryHash: null }],
    ["edited after it was written", { ...scheduled({}), summary: "edited" }],
    ["written by another actor", scheduled({}, "marketing-publisher")],
    ["about another post", scheduled({ targetId: "post-other" })],
  ] as const) {
    const { database, seen } = fakeDatabase({
      post: postRow({ mode: "autonomous" }),
      scheduledRow: row as StoredAuditRow,
    });
    assert.deepEqual(
      await dispatch(database),
      { started: false, reason: "provenance_changed" },
      label,
    );
    assert.equal(seen.updates.length, 0, label);
  }
});

test("an approval that expires while the dispatch works is judged at the later clock", async () => {
  // Valid at the clock the dispatch read first; expired at the one the resolver
  // read last. The later one decides.
  const { database, seen } = fakeDatabase({
    post: postRow({ approvalExpiresAt: new Date(NOW.getTime() + 1_000) }),
  });
  const result = await dispatch(database, {
    resolveAdmission: async () => ({
      publish: true,
      ...PROVENANCE,
      checkedAt: new Date(NOW.getTime() + 1_000),
    }),
  });
  assert.deepEqual(result, { started: false, reason: "approval_not_current" });
  assert.equal(seen.updates.length, 0);
});

test("a lease that runs out while the dispatch works is judged at the later clock", async () => {
  const { database } = fakeDatabase();
  const result = await dispatch(database, {
    resolveAdmission: async () => ({ publish: true, ...PROVENANCE, checkedAt: LEASE_UNTIL }),
    runDeadlineAt: new Date(LEASE_UNTIL.getTime() + 60 * 60 * 1000),
  });
  assert.deepEqual(result, { started: false, reason: "claim_expired" });
});

test("a started dispatch tells the caller when its approval expires", async () => {
  const { database } = fakeDatabase();
  const result = await dispatch(database);
  assert.equal(result.started, true);
  if (result.started) {
    assert.equal(result.approvalExpiresAt?.toISOString(), "2026-09-30T09:00:00.000Z");
  }
  const autonomous = fakeDatabase({
    post: postRow({ mode: "autonomous" }),
    scheduledMetadata: PROVENANCE,
  });
  const started = await dispatch(autonomous.database);
  assert.equal(started.started && started.approvalExpiresAt, null);
});
