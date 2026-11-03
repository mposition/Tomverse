// Graduation to autonomous publishing (S4b; policy O3 and section 8.2).
//
// The conditions are a pure function of counts, tested at their edges. The
// store function is tested against a fake database for what it must refuse and
// what it writes; the trigger, the lock and the chain are the DB suite's.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
  adminAuditEntryHashVariants,
} from "@/lib/adminAuditIntegrityCore";
import {
  MARKETING_GRADUATE_ACTION,
  MARKETING_GRADUATION_UNMET_CODES,
  MarketingStoreRefusedError,
  evaluateMarketingGraduation,
  graduateMarketingChannel,
  type MarketingGraduationMetrics,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import { marketingGraduationSnapshotSchema } from "@/lib/marketingAutomationSchema";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-08T09:00:00.000Z");
const STARTED = new Date("2026-10-25T00:00:00.000Z");
const auditSecret = "marketing-graduation-unit-secret";

const metrics = (overrides: Partial<MarketingGraduationMetrics> = {}): MarketingGraduationMetrics => ({
  observedFromAt: STARTED,
  firstSuccessAt: new Date(NOW.getTime() - 7 * DAY),
  approvedPostCount: 3,
  editedApprovedCount: 0,
  draftCount: 3,
  guardRejectedCount: 0,
  ...overrides,
});

const evaluate = (
  overrides: Partial<MarketingGraduationMetrics> = {},
  input: { status?: string; channel?: string; commentsMonitorHealthy?: boolean } = {},
) =>
  evaluateMarketingGraduation({
    status: input.status ?? "approval_mode",
    channel: input.channel ?? "linkedin",
    metrics: metrics(overrides),
    now: NOW,
    commentsMonitorHealthy: input.commentsMonitorHealthy ?? true,
  });

// ---------------------------------------------------------------------------
// The conditions
// ---------------------------------------------------------------------------

test("an account that meets every condition is eligible, exactly at the edges", () => {
  const result = evaluate();
  assert.deepEqual(result.unmet, []);
  assert.equal(result.eligible, true);
});

test("seven days after the first success are counted from the database's own instant", () => {
  assert.deepEqual(
    evaluate({ firstSuccessAt: new Date(NOW.getTime() - 7 * DAY + 1) }).unmet,
    ["first_success_too_recent"],
  );
  assert.deepEqual(evaluate({ firstSuccessAt: null }).unmet, ["first_success_missing"]);
});

test("three approvals are needed, not two", () => {
  assert.deepEqual(evaluate({ approvedPostCount: 2, draftCount: 2 }).unmet, ["approvals_below_minimum"]);
});

test("the edit rate is at most a third of the approved posts; rejections are not in the denominator", () => {
  // 1 edit in 3 approvals is exactly a third: allowed.
  assert.equal(evaluate({ approvedPostCount: 3, editedApprovedCount: 1 }).eligible, true);
  // 2 edits in 3 approvals is not.
  assert.deepEqual(evaluate({ approvedPostCount: 3, editedApprovedCount: 2 }).unmet, ["edit_rate_above_limit"]);
  // Operator rejections do not dilute the rate: 2 edits in 3 approvals stays above a third.
  assert.deepEqual(
    evaluate({ approvedPostCount: 3, editedApprovedCount: 2, draftCount: 6 }).unmet,
    ["edit_rate_above_limit"],
  );
  assert.equal(evaluate({ approvedPostCount: 3, editedApprovedCount: 1 }).operatorEditRate, 1 / 3);
});

test("Instagram and TikTok never graduate, whatever else is true", () => {
  for (const channel of ["instagram", "tiktok"]) {
    assert.deepEqual(evaluate({}, { channel }).unmet, ["channel_never_graduates"]);
  }
});

test("without comment monitoring there is no graduation", () => {
  assert.deepEqual(evaluate({}, { commentsMonitorHealthy: false }).unmet, ["comments_monitor_unhealthy"]);
});

test("every unmet condition is reported at once, in the closed order", () => {
  const result = evaluate(
    { firstSuccessAt: null, approvedPostCount: 0, draftCount: 0 },
    { status: "paused", commentsMonitorHealthy: false },
  );
  assert.deepEqual(result.unmet, [
    "not_in_approval_mode",
    "first_success_missing",
    "approvals_below_minimum",
    "comments_monitor_unhealthy",
  ]);
  for (const code of result.unmet) assert.ok((MARKETING_GRADUATION_UNMET_CODES as readonly string[]).includes(code));
});

test("the guard rejection rate is recorded, not a condition", () => {
  const result = evaluate({ draftCount: 10, guardRejectedCount: 5 });
  assert.equal(result.guardRejectionRate, 0.5);
  assert.equal(result.eligible, true);
});

// ---------------------------------------------------------------------------
// The store function
// ---------------------------------------------------------------------------

const CHANNEL_ID = "channel-1";

const signedAudit = (overrides: Partial<{ action: string; metadata: Record<string, unknown>; createdAt: Date }> = {}) => {
  const hashInput = {
    previousHash: null,
    actorUserId: "operator-1",
    actorEmail: "owner@example.test",
    action: overrides.action ?? MARKETING_GRADUATE_ACTION,
    targetType: "MarketingChannel",
    targetId: CHANNEL_ID,
    summary: "Graduation test decision.",
    metadata: { actorHadMarketingWrite: true, graduationEpoch: 0, ...overrides.metadata },
    ipAddress: null,
    userAgent: null,
    createdAt: (overrides.createdAt ?? new Date(NOW.getTime() - 1000)).toISOString(),
  };
  return {
    id: "audit-1",
    ...hashInput,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 1000),
    entryHash: adminAuditEntryHashVariants(hashInput, auditSecret)[ADMIN_AUDIT_SIGNING_KEY_ORDER],
  };
};

const withAuditKey = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = auditSecret;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previous;
  }
};

type Post = {
  status: string;
  approvedAt: Date | null;
  publishedAt: Date | null;
  history: unknown;
};

const approvedPost = (extra: Partial<Post> = {}): Post => ({
  status: "published",
  approvedAt: new Date(NOW.getTime() - 8 * DAY),
  publishedAt: new Date(NOW.getTime() - 8 * DAY),
  history: [],
  ...extra,
});

const world = (
  options: {
    status?: string;
    channel?: string;
    epoch?: number;
    posts?: Post[];
    audit?: ReturnType<typeof signedAudit> | null;
    updates?: number;
  } = {},
) => {
  const { status = "approval_mode", channel = "linkedin", epoch = 0, updates = 1 } = options;
  const posts = options.posts ?? [approvedPost(), approvedPost(), approvedPost()];
  const audit = options.audit === undefined ? signedAudit() : options.audit;
  const written: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const database = {
    async $queryRaw(query: unknown) {
      const strings = (query as { strings?: readonly string[] }).strings;
      const sql = strings ? strings.join("?") : String(query);
      if (sql.includes("clock_timestamp")) return [{ now: NOW, createdAt: NOW }];
      if (sql.includes("FOR UPDATE")) {
        return [
          {
            id: CHANNEL_ID,
            channel,
            status,
            connectionGeneration: 1,
            scopesDigest: "b".repeat(64),
            policyVersion: 1,
            graduationEpoch: epoch,
            graduatedAt: null,
            graduationSnapshot: null,
            pausedAt: null,
            pausedFromMode: null,
            pauseReasonCode: null,
            lastResumeAuditLogId: null,
            dailyCapOverride: null,
            weeklyCapOverride: null,
            externalAccountRef: "acct",
            approvalStartedAt: STARTED,
          },
        ];
      }
      throw new Error(`unexpected raw statement: ${sql}`);
    },
    marketingPost: {
      // Honours the page size and the cursor, as the real table does.
      findMany: async (args: { take?: number; cursor?: { id: string }; skip?: number }) => {
        const all = posts.map((post, index) => ({ id: `post-${index}`, ...post }));
        const start = args.cursor ? all.findIndex((post) => post.id === args.cursor?.id) + (args.skip ?? 0) : 0;
        return all.slice(start, start + (args.take ?? all.length));
      },
    },
    marketingChannel: {
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        written.push(input);
        return { count: updates };
      },
    },
    adminAuditLog: { findUnique: async () => audit, findFirst: async () => null },
  };
  return { database: database as unknown as MarketingTransaction, written };
};

const graduate = (
  database: MarketingTransaction,
  overrides: Partial<{ expectedGraduationEpoch: number; commentsMonitorHealthy: boolean }> = {},
) =>
  withAuditKey(() =>
    graduateMarketingChannel(database, {
      id: CHANNEL_ID,
      auditLogId: "audit-1",
      expectedGraduationEpoch: 0,
      commentsMonitorHealthy: true,
      ...overrides,
    }),
  );

const refusedWith = (code: string) => (error: unknown) =>
  error instanceof MarketingStoreRefusedError && error.code === code;

test("a graduation writes the mode, the instant and a snapshot of counts under a compare-and-set", async () => {
  const { database, written } = world({
    posts: [
      approvedPost(),
      approvedPost({ history: [{ type: "edit_revision" }] }),
      approvedPost(),
      { status: "guard_rejected", approvedAt: null, publishedAt: null, history: [] },
    ],
  });
  const result = await graduate(database);
  assert.equal(result.graduated, true);
  if (!result.graduated) return;
  const { snapshot } = result;

  assert.equal(written.length, 1);
  assert.deepEqual(written[0].where, {
    id: CHANNEL_ID,
    status: "approval_mode",
    graduationEpoch: 0,
    policyVersion: 1,
  });
  assert.equal(written[0].data.status, "autonomous_mode");
  assert.deepEqual(written[0].data.graduatedAt, NOW);
  assert.deepEqual(marketingGraduationSnapshotSchema.parse(written[0].data.graduationSnapshot), snapshot);
  assert.equal(snapshot.approvedPostCount, 3);
  assert.equal(snapshot.operatorEditRate, 1 / 3);
  assert.equal(snapshot.guardRejectionRate, 0.25);
  assert.equal(snapshot.approvalAuditLogId, "audit-1");
  assert.equal(snapshot.observedFromAt, STARTED.toISOString());
});

test("operator rejections do not dilute the edit rate: it is edits over approvals", async () => {
  const rejected = { status: "rejected", approvedAt: null, publishedAt: null, history: [] };
  const edit = { history: [{ type: "edit_revision" }] };
  // 2 edits in 3 approvals is above a third, however many drafts were rejected.
  const refused = await graduate(
    world({ posts: [approvedPost(edit), approvedPost(edit), approvedPost(), rejected, rejected, rejected] }).database,
  );
  assert.deepEqual(refused, { graduated: false, unmet: ["edit_rate_above_limit"] });
  // 1 edit in 3 approvals is exactly a third, and the rejections change nothing.
  const allowed = await graduate(
    world({ posts: [approvedPost(edit), approvedPost(), approvedPost(), rejected] }).database,
  );
  assert.equal(allowed.graduated, true);
  if (allowed.graduated) assert.equal(allowed.snapshot.operatorEditRate, 1 / 3);
});

test("it answers with every unmet condition and writes nothing", async () => {
  const { database, written } = world({ posts: [approvedPost()] });
  const result = await graduate(database, { commentsMonitorHealthy: false });
  assert.deepEqual(result, {
    graduated: false,
    unmet: ["approvals_below_minimum", "comments_monitor_unhealthy"],
  });
  assert.equal(written.length, 0);
});

test("it refuses an account outside approval mode and a channel that never graduates", async () => {
  for (const options of [{ status: "paused" }, { status: "autonomous_mode" }, { channel: "instagram" }, { channel: "tiktok" }]) {
    const { database, written } = world(options);
    const result = await graduate(database);
    assert.equal(result.graduated, false);
    assert.equal(written.length, 0);
  }
});

test("it refuses when the page was read in an earlier approval period", async () => {
  const { database, written } = world({ epoch: 1 });
  await assert.rejects(graduate(database), refusedWith("channel_changed_under_us"));
  assert.equal(written.length, 0);
});

test("it needs the operator's confirmation entry: missing, wrong action, wrong epoch, or older than the period", async () => {
  const cases: Array<[ReturnType<typeof signedAudit> | null, string]> = [
    [null, "audit_evidence_entry_missing"],
    [signedAudit({ action: "marketing_account.pause" }), "audit_evidence_action_mismatch"],
    [signedAudit({ metadata: { graduationEpoch: 5 } }), "audit_evidence_metadata_mismatch"],
    [signedAudit({ createdAt: new Date(STARTED.getTime() - DAY) }), "audit_evidence_entry_predates_decision"],
  ];
  for (const [audit, code] of cases) {
    const { database, written } = world({ audit });
    await assert.rejects(graduate(database), refusedWith(code), code);
    assert.equal(written.length, 0);
  }
});

test("a compare-and-set that loses is a refusal, not a silent success", async () => {
  const { database } = world({ updates: 0 });
  await assert.rejects(graduate(database), refusedWith("channel_changed_under_us"));
});

test("only posts of the current approval period were read, and its start is the lower bound", async () => {
  let observed: unknown;
  const { database } = world();
  const original = (database as unknown as { marketingPost: { findMany: (args: unknown) => Promise<unknown> } }).marketingPost;
  const findMany = original.findMany;
  original.findMany = async (args: unknown) => {
    observed ??= args;
    return findMany(args);
  };
  await graduate(database);
  assert.deepEqual((observed as { where: Record<string, unknown> }).where, {
    channelId: CHANNEL_ID,
    createdAt: { gte: STARTED },
  });
});

test("every post of the period is counted, however many there are: late edits past the first pages still count", async () => {
  // 600 approved posts, the first 400 untouched and the last 200 edited: 200 of
  // 600 is exactly a third and is allowed, one more edit is not. Counting only
  // the first page or the first 500 would have said 0 and 100 edits.
  const untouched = Array.from({ length: 400 }, () => approvedPost());
  const edited = (n: number) => Array.from({ length: n }, () => approvedPost({ history: [{ type: "edit_revision" }] }));
  const allowed = world({ posts: [...untouched, ...edited(200)] });
  const ok = await graduate(allowed.database);
  assert.equal(ok.graduated, true);
  if (ok.graduated) assert.equal(ok.snapshot.approvedPostCount, 600);

  const over = world({ posts: [...untouched, ...edited(201)] });
  const refused = await graduate(over.database);
  assert.deepEqual(refused, { graduated: false, unmet: ["edit_rate_above_limit"] });
});
