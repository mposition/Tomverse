// The system stops a brand account by itself (S4a; policy section 8.3).
//
// Three halves. The pure decision (thresholds, priority, the evidence window),
// the store transaction against a fake database that can be made to fail where
// a real one would, and the publisher's use of it before it claims anything.
// What a real database adds -- the channel trigger, the row lock, the chain --
// is covered by the DB integration test.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_AUTO_PAUSE_ACTION,
  MARKETING_AUTO_PAUSE_REASON_CODES,
  decideMarketingAutoPause,
  marketingAutoPauseWindowStart,
  marketingConsecutiveFailuresTripped,
  marketingGuardRejectionTripped,
} from "@/lib/marketingStore";
import { runMarketingPublisherBatch } from "@/lib/marketingPublisherBatch";
import {
  MARKETING_PAUSE_REASON_CODES,
  MARKETING_SAFETY_PAUSE_REASON_CODES,
} from "@/lib/marketingAutomationSchema";
import {
  evaluateMarketingAutoPause,
  MARKETING_S2B1_ACTIONS,
  MARKETING_RESUME_AUTONOMOUS_ACTION,
  type MarketingTransaction,
} from "@/lib/marketingStore";

const CHANNEL_ID = "chn_linkedin_en";
const NOW = new Date("2026-11-01T09:00:00.000Z");
const APPROVAL_STARTED = new Date("2026-10-25T00:00:00.000Z");

const draftStatuses = (rejected: number, others: number): string[] => [
  ...Array.from({ length: rejected }, () => "guard_rejected"),
  ...Array.from({ length: others }, () => "pending_approval"),
];

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("the guard rate trips at seven rejections in twenty, not at six", () => {
  assert.equal(marketingGuardRejectionTripped(draftStatuses(6, 14)), false);
  assert.equal(marketingGuardRejectionTripped(draftStatuses(7, 13)), true);
});

test("fewer than twenty drafts still divide by twenty", () => {
  // Six of six is every draft rejected and still not enough: a new account's
  // first drafts cannot stop it on a rate of one.
  assert.equal(marketingGuardRejectionTripped(draftStatuses(6, 0)), false);
  assert.equal(marketingGuardRejectionTripped(draftStatuses(7, 0)), true);
});

test("only the newest twenty drafts are counted", () => {
  const newestTwenty = draftStatuses(6, 14);
  const older = draftStatuses(10, 0);
  assert.equal(marketingGuardRejectionTripped([...newestTwenty, ...older]), false);
});

test("three consecutive failures trip; anything else in the newest three does not", () => {
  assert.equal(marketingConsecutiveFailuresTripped(["failed", "failed", "failed"]), true);
  assert.equal(
    marketingConsecutiveFailuresTripped(["failed", "failed", "failed", "published"]),
    true,
  );
  assert.equal(marketingConsecutiveFailuresTripped(["failed", "failed"]), false);
  assert.equal(marketingConsecutiveFailuresTripped(["failed", "published", "failed"]), false);
  // An unknown outcome is the S2d2 path and does not count as a plain failure.
  assert.equal(
    marketingConsecutiveFailuresTripped(["failed", "failed", "outcome_unknown"]),
    false,
  );
});

test("the most severe fact decides the reason", () => {
  const everything = {
    removedPostCount: 1,
    recentAttemptOutcomes: ["failed", "failed", "failed"],
    recentDraftStatuses: draftStatuses(9, 11),
  };
  assert.equal(decideMarketingAutoPause(everything), "platform_removal");
  assert.equal(
    decideMarketingAutoPause({ ...everything, removedPostCount: 0 }),
    "consecutive_publish_failures",
  );
  assert.equal(
    decideMarketingAutoPause({ ...everything, removedPostCount: 0, recentAttemptOutcomes: [] }),
    "guard_rejection_rate",
  );
  assert.equal(
    decideMarketingAutoPause({
      removedPostCount: 0,
      recentAttemptOutcomes: [],
      recentDraftStatuses: [],
    }),
    null,
  );
});

test("the window starts at the latest instant that exists", () => {
  const early = new Date("2026-10-01T00:00:00.000Z");
  const late = new Date("2026-10-20T00:00:00.000Z");
  assert.deepEqual(marketingAutoPauseWindowStart([early, null, late, undefined]), late);
  assert.equal(marketingAutoPauseWindowStart([null, undefined]), null);
});

test("the reason codes are closed and apart from the operator's and the unknown-outcome one", () => {
  const taken = new Set<string>([
    ...MARKETING_PAUSE_REASON_CODES,
    ...MARKETING_SAFETY_PAUSE_REASON_CODES,
  ]);
  for (const code of MARKETING_AUTO_PAUSE_REASON_CODES) assert.equal(taken.has(code), false);
  assert.equal(new Set(MARKETING_AUTO_PAUSE_REASON_CODES).size, MARKETING_AUTO_PAUSE_REASON_CODES.length);
});

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

const asTransaction = (database: unknown): MarketingTransaction =>
  database as MarketingTransaction;

const statementText = (query: unknown): string => {
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

type Updated = { where: Record<string, unknown>; data: Record<string, unknown> };

type World = {
  status?: string;
  /** The audit row that last started the account's window, if any. */
  freshStartAt?: Date | null;
  removedPosts?: number;
  attempts?: string[];
  drafts?: string[];
  channelUpdates?: number[];
  failOn?: "lock" | "attempts" | "drafts" | "count" | "audit";
};

const world = (options: World = {}) => {
  const {
    status = "approval_mode",
    freshStartAt = null,
    removedPosts = 0,
    attempts = [],
    drafts = [],
    channelUpdates = [1],
    failOn,
  } = options;
  const seen = {
    channelUpdates: [] as Updated[],
    audits: [] as Record<string, unknown>[],
    rawValues: [] as unknown[][],
    countWhere: [] as Record<string, unknown>[],
    draftWhere: [] as Record<string, unknown>[],
    reads: [] as string[],
  };
  let channelUpdate = 0;
  const channelRow = {
    id: CHANNEL_ID,
    channel: "linkedin",
    status,
    connectionGeneration: 1,
    pausedAt: null,
    pausedFromMode: null,
    pauseReasonCode: null,
    approvalStartedAt: APPROVAL_STARTED,
  };
  const database = {
    async $executeRaw() {
      return 0;
    },
    async $queryRaw(query: unknown) {
      const sql = statementText(query);
      if (sql.includes("jsonb_array_elements")) {
        seen.reads.push("attempts");
        seen.rawValues.push([...((query as { values?: unknown[] }).values ?? [])]);
        if (failOn === "attempts") throw new Error("injected: attempts read lost");
        return attempts.map((outcome) => ({ outcome }));
      }
      if (sql.includes("clock_timestamp")) return [{ now: NOW, createdAt: NOW }];
      if (sql.includes("FOR UPDATE")) {
        seen.reads.push("lock");
        if (failOn === "lock") throw new Error("injected: lock lost");
        return [channelRow];
      }
      throw new Error(`unexpected raw statement: ${sql}`);
    },
    marketingPost: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        seen.reads.push("count");
        seen.countWhere.push(where);
        if (failOn === "count") throw new Error("injected: count lost");
        return removedPosts;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        seen.reads.push("drafts");
        seen.draftWhere.push(where);
        if (failOn === "drafts") throw new Error("injected: drafts read lost");
        return drafts.map((draftStatus) => ({ status: draftStatus }));
      },
    },
    marketingReport: { findFirst: async () => ({ createdAt: NOW, payload: { firstDetectedAt: NOW.toISOString() } }) },
    marketingChannel: {
      updateMany: async (input: Updated) => {
        seen.channelUpdates.push(input);
        const count = channelUpdates[channelUpdate] ?? 0;
        channelUpdate += 1;
        return { count };
      },
    },
    adminAuditLog: {
      findFirst: async (args: { where?: { action?: unknown } }) => {
        if (args?.where?.action && typeof args.where.action === "object") {
          seen.reads.push("windowMarker");
          return freshStartAt ? { createdAt: freshStartAt } : null;
        }
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (failOn === "audit") throw new Error("injected: audit write lost");
        seen.audits.push(data);
        return data;
      },
    },
  };
  return { database, seen };
};

test("three failed attempts stop an account in approval mode, with one audit entry", async () => {
  const { database, seen } = world({ attempts: ["failed", "failed", "failed"] });

  const result = await evaluateMarketingAutoPause(asTransaction(database), {
    channelId: CHANNEL_ID,
  });

  assert.deepEqual(result, {
    paused: true,
    reasonCode: "consecutive_publish_failures",
    pausedFromMode: "approval_mode",
  });
  assert.equal(seen.channelUpdates.length, 1);
  // Compare-and-set on the mode that was read under the lock; the trigger, not
  // this code, records where the pause came from.
  assert.deepEqual(seen.channelUpdates[0], {
    where: { id: CHANNEL_ID, status: "approval_mode" },
    data: { status: "paused", pauseReasonCode: "consecutive_publish_failures" },
  });
  assert.equal(seen.audits.length, 1);
  assert.equal(seen.audits[0].action, MARKETING_AUTO_PAUSE_ACTION);
  assert.equal(seen.audits[0].targetType, "MarketingChannel");
  assert.equal(seen.audits[0].targetId, CHANNEL_ID);
});

test("an autonomous account is stopped by the same evidence", async () => {
  const { database, seen } = world({
    status: "autonomous_mode",
    attempts: ["failed", "failed", "failed"],
  });
  const result = await evaluateMarketingAutoPause(asTransaction(database), {
    channelId: CHANNEL_ID,
  });
  assert.equal(result.paused, true);
  assert.equal(seen.channelUpdates[0].where.status, "autonomous_mode");
});

test("two failures, or a success among the last three, stop nothing", async () => {
  for (const attempts of [["failed", "failed"], ["failed", "published", "failed"]]) {
    const { database, seen } = world({ attempts });
    const result = await evaluateMarketingAutoPause(asTransaction(database), {
      channelId: CHANNEL_ID,
    });
    assert.deepEqual(result, { paused: false });
    assert.equal(seen.channelUpdates.length, 0);
    assert.equal(seen.audits.length, 0);
  }
});

test("the guard rate stops at seven rejections and not at six", async () => {
  const six = world({ drafts: draftStatuses(6, 14) });
  assert.deepEqual(
    await evaluateMarketingAutoPause(asTransaction(six.database), { channelId: CHANNEL_ID }),
    { paused: false },
  );
  assert.equal(six.seen.audits.length, 0);

  const seven = world({ drafts: draftStatuses(7, 13) });
  const result = await evaluateMarketingAutoPause(asTransaction(seven.database), {
    channelId: CHANNEL_ID,
  });
  assert.equal(result.paused && result.reasonCode, "guard_rejection_rate");
  const metadata = seven.seen.audits[0].metadata as Record<string, unknown>;
  assert.equal(metadata.draftsGuardRejected, 7);
  assert.equal(metadata.draftsConsidered, 20);
});

test("a platform removal stops an account and needs no other evidence", async () => {
  const { database, seen } = world({ removedPosts: 1 });
  const result = await evaluateMarketingAutoPause(asTransaction(database), {
    channelId: CHANNEL_ID,
  });
  assert.equal(result.paused && result.reasonCode, "platform_removal");
  // Decided on the first fact: the later reads are not made.
  assert.equal(seen.reads.includes("attempts"), false);
  assert.equal(seen.reads.includes("drafts"), false);
});

test("an account that is not in a live mode is left alone and nothing is read", async () => {
  for (const status of ["paused", "disconnected", "connect_pending"]) {
    const { database, seen } = world({ status, removedPosts: 5 });
    const result = await evaluateMarketingAutoPause(asTransaction(database), {
      channelId: CHANNEL_ID,
    });
    assert.deepEqual(result, { paused: false });
    assert.deepEqual(seen.reads, ["lock"]);
    assert.equal(seen.channelUpdates.length, 0);
  }
});

test("a forced reason stops the account without reading evidence", async () => {
  const { database, seen } = world();
  const result = await evaluateMarketingAutoPause(asTransaction(database), {
    channelId: CHANNEL_ID,
    forcedReason: "unhandled_comment_alert",
    forcedAlerts: [{ postId: "p1", firstDetectedAt: NOW }],
    forcedOverdueBefore: NOW,
  });
  assert.equal(result.paused && result.reasonCode, "unhandled_comment_alert");
  assert.equal(seen.reads.includes("count"), false);
  assert.equal(seen.reads.includes("attempts"), false);
});

test("a concurrent change that wins the compare-and-set leaves no audit entry", async () => {
  // The row was moved between the lock read and the write: nothing was stopped
  // by this call, so nothing is recorded as stopped.
  const { database, seen } = world({
    attempts: ["failed", "failed", "failed"],
    channelUpdates: [0],
  });
  const result = await evaluateMarketingAutoPause(asTransaction(database), {
    channelId: CHANNEL_ID,
  });
  assert.deepEqual(result, { paused: false });
  assert.equal(seen.audits.length, 0);
});

test("evidence counts only from the account's last fresh start", async () => {
  const resumedAt = new Date("2026-10-30T00:00:00.000Z");
  const { database, seen } = world({ freshStartAt: resumedAt, drafts: draftStatuses(7, 13) });
  await evaluateMarketingAutoPause(asTransaction(database), { channelId: CHANNEL_ID });
  // The later of the approval start and the resume entry is the lower bound of
  // every read, so the entries that stopped the account do not stop it again.
  assert.deepEqual(seen.countWhere[0].updatedAt, { gt: resumedAt });
  assert.deepEqual(seen.draftWhere[0].createdAt, { gt: resumedAt });
  assert.ok(seen.rawValues[0].some((value) => value instanceof Date && +value === +resumedAt));

  const never = world({ freshStartAt: null });
  await evaluateMarketingAutoPause(asTransaction(never.database), { channelId: CHANNEL_ID });
  assert.deepEqual(never.seen.draftWhere[0].createdAt, { gt: APPROVAL_STARTED });
});

test("the window marker looks for the auto pause and both resumes", async () => {
  let observed: unknown;
  const { database } = world();
  const original = database.adminAuditLog.findFirst;
  database.adminAuditLog.findFirst = async (args) => {
    observed = args;
    return original(args);
  };
  await evaluateMarketingAutoPause(asTransaction(database), { channelId: CHANNEL_ID });
  const where = (observed as { where: { action: { in: string[] }; targetId: string } }).where;
  assert.deepEqual(new Set(where.action.in), new Set([
    MARKETING_AUTO_PAUSE_ACTION,
    MARKETING_S2B1_ACTIONS.accountResumeApproval,
    MARKETING_RESUME_AUTONOMOUS_ACTION,
  ]));
  assert.equal(where.targetId, CHANNEL_ID);
});

test("a read that is lost fails the call and stops nothing", async () => {
  for (const failOn of ["lock", "count", "attempts", "drafts"] as const) {
    const { database, seen } = world({ failOn, attempts: ["failed", "failed", "failed"] });
    await assert.rejects(
      evaluateMarketingAutoPause(asTransaction(database), { channelId: CHANNEL_ID }),
      /injected/,
    );
    assert.equal(seen.channelUpdates.length, 0, `${failOn}: no status change`);
    assert.equal(seen.audits.length, 0, `${failOn}: no audit entry`);
  }
});

test("an audit write that is lost fails the call, so the transaction rolls the stop back", async () => {
  const { database } = world({ failOn: "audit", attempts: ["failed", "failed", "failed"] });
  await assert.rejects(
    evaluateMarketingAutoPause(asTransaction(database), { channelId: CHANNEL_ID }),
    /injected/,
  );
});

// ---------------------------------------------------------------------------
// The publisher
// ---------------------------------------------------------------------------

const DEADLINE = new Date(NOW.getTime() + 4 * 60 * 1000);

const batchWorld = (evaluateAutoPause?: (channelId: string) => Promise<{ paused: boolean }>) => {
  const calls: string[] = [];
  const operations = {
    listChannels: async () => [
      { id: "c1", connectionGeneration: 1, externalAccountRef: "acct_1" },
      { id: "c2", connectionGeneration: 1, externalAccountRef: "acct_2" },
    ],
    listPublishingPastLease: async () => [],
    listAwaitingVerification: async () => [],
    claim: async (input: unknown) => {
      calls.push(`claim:${(input as { channelId: string }).channelId}`);
      return { claimed: false, reason: "nothing_due" };
    },
    release: async () => ({ released: true }),
    dispatch: async () => {
      throw new Error("not reached");
    },
    recordPublished: async () => ({ recorded: true }),
    recordFailed: async () => ({ recorded: true }),
    recordOutcomeUnknown: async () => ({ recorded: true }),
    recordVerified: async () => ({ recorded: true }),
    ...(evaluateAutoPause
      ? {
          evaluateAutoPause: async (channelId: string) => {
            calls.push(`evaluate:${channelId}`);
            return evaluateAutoPause(channelId);
          },
        }
      : {}),
  };
  const adapter = {
    provider: "zernio",
    capabilities: async () => {
      throw new Error("not asked");
    },
    observeHealth: async (ref: string) => {
      calls.push(`health:${ref}`);
      return { capability: "publish", healthy: true, reason: null };
    },
    publish: async () => {
      throw new Error("not reached");
    },
    lookupByRequestKey: async () => ({ outcome: "outcome_unknown", errorCode: "x" }),
    lookupStatus: async () => ({ state: "unknown" }),
  };
  return {
    calls,
    run: () =>
      runMarketingPublisherBatch(
        {
          operations: operations as never,
          adapter: adapter as never,
          databaseNow: async () => NOW,
          heartbeat: async () => true,
        },
        { runId: "run-1", deadlineAt: DEADLINE },
      ),
  };
};

test("a stopped account is not asked about its health or offered a claim", async () => {
  const { calls, run } = batchWorld(async (channelId) => ({ paused: channelId === "c1" }));
  const result = await run();
  assert.equal(result.refused["auto_pause:paused"], 1);
  assert.equal(calls.includes("claim:c1"), false);
  assert.equal(calls.includes("health:acct_1"), false);
  // The other account is judged on its own.
  assert.ok(calls.includes("claim:c2"));
});

test("a decision that cannot be made skips the account for this run and the run goes on", async () => {
  const { calls, run } = batchWorld(async (channelId) => {
    if (channelId === "c1") throw new Error("injected: serialization failure");
    return { paused: false };
  });
  const result = await run();
  assert.equal(result.refused["auto_pause:undecided"], 1);
  assert.equal(calls.includes("claim:c1"), false);
  assert.ok(calls.includes("claim:c2"));
});

test("the evaluation comes before the account's health probe and claim", async () => {
  const { calls, run } = batchWorld(async () => ({ paused: false }));
  await run();
  const first = calls.filter((call) => /:(c1|acct_1)$/.test(call));
  assert.deepEqual(first, ["evaluate:c1", "health:acct_1", "claim:c1"]);
});

test("a batch without the evaluation behaves as it did", async () => {
  const { calls, run } = batchWorld();
  const result = await run();
  assert.equal(result.claimed, 0);
  assert.ok(calls.includes("claim:c1") && calls.includes("claim:c2"));
});
