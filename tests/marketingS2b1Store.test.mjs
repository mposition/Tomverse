import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  adminAuditEntryHashVariants,
  ADMIN_AUDIT_SIGNING_KEY_ORDER,
} from "../lib/adminAuditIntegrityCore.ts";
import {
  approveMarketingPost,
  createMarketingChannel,
  lowerMarketingChannelCaps,
  markMarketingPostReusable,
  MarketingStoreRefusedError,
  MARKETING_REFUSAL_STATUS,
  MARKETING_S2B1_ACTIONS,
  requeueMarketingPostAfterFailure,
  resumeMarketingChannelToAutonomous,
} from "../lib/marketingStore.ts";

const DIGEST = "b".repeat(64);
const auditSecret = "marketing-s2b1-store-unit-secret";

const signedAudit = ({
  id = "audit-1",
  action,
  targetId,
  metadata,
  createdAt = new Date("2026-09-22T00:01:00.000Z"),
}) => {
  const hashInput = {
    previousHash: null,
    actorUserId: "operator-1",
    actorEmail: "owner@example.test",
    action,
    targetType: targetId.startsWith("channel-")
      ? "MarketingChannel"
      : "MarketingPost",
    targetId,
    summary: "S2b1 test decision.",
    metadata: { actorHadMarketingWrite: true, ...metadata },
    ipAddress: null,
    userAgent: null,
    createdAt: createdAt.toISOString(),
  };
  return {
    id,
    ...hashInput,
    createdAt,
    entryHash:
      adminAuditEntryHashVariants(hashInput, auditSecret)[
        ADMIN_AUDIT_SIGNING_KEY_ORDER
      ],
  };
};

const withAuditKey = async (operation) => {
  const previous = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = auditSecret;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previous;
  }
};

const auditReader = (entry) => ({
  findUnique: async () => entry,
  findFirst: async () => null,
});

test("S2b1 action names are the exact approved inventory strings", () => {
  assert.deepEqual(Object.values(MARKETING_S2B1_ACTIONS), [
    "marketing_account.create",
    "marketing_account.connection_confirmed",
    "marketing_account.disconnect",
    "marketing_account.reconnect",
    "marketing_account.scopes_changed",
    "marketing_account.policy_version_changed",
    "marketing_account.pause",
    "marketing_account.resume_approval",
    "marketing_post.approval_expired_on_resume",
    "marketing_account.resume_autonomous",
    "marketing_account.lower_caps",
    "marketing_post.approve",
    "marketing_post.reject",
    "marketing_post.edit",
    "marketing_post.mark_reusable",
    "marketing_post.schedule",
    "marketing_post.requeue_after_failure",
    "marketing_post.legal_hold_set",
    "marketing_post.legal_hold_released",
    "marketing_post.resolve_outcome_unknown",
    "marketing_post.unpublish",
    // The three switches the console may change. The webhook shadow switch and
    // the apply scope are absent on purpose: they belong to S2e and S2f, and an
    // action name for them here would be the first half of a route that skips
    // the evidence those slices exist to collect.
    "marketing_setting.drafts_changed",
    "marketing_setting.publish_changed",
    "marketing_setting.autonomous_changed",
  ]);
});

test("channel creation materialises every caller field before awaiting the slug", async () => {
  const reads = new Map();
  const once = (name, value) => ({
    enumerable: true,
    get() {
      reads.set(name, (reads.get(name) ?? 0) + 1);
      return value;
    },
  });
  const raw = {};
  Object.defineProperties(raw, {
    channel: once("channel", "linkedin"),
    provider: once("provider", "zernio"),
    externalAccountRef: once("externalAccountRef", "account-ref"),
    defaultLocale: once("defaultLocale", "en"),
    allowedLocales: once("allowedLocales", ["en"]),
    scopesDigest: once("scopesDigest", DIGEST),
    policyVersion: once("policyVersion", 1),
  });
  let inserted;
  await createMarketingChannel(
    {
      marketingChannel: {
        findMany: async () => [],
        create: async ({ data }) => {
          inserted = data;
          return data;
        },
      },
    },
    raw,
  );
  assert.equal(inserted.accountSlug, "linkedin-1");
  assert.deepEqual(Object.fromEntries(reads), {
    channel: 1,
    provider: 1,
    externalAccountRef: 1,
    defaultLocale: 1,
    allowedLocales: 1,
    scopesDigest: 1,
    policyVersion: 1,
  });
});

const pendingPost = () => ({
  id: "post-1",
  channelId: "channel-1",
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  status: "pending_approval",
  envelope: null,
  envelopeDigest: DIGEST,
  approvedDigest: null,
  approvalAuditLogId: null,
  approvedAt: null,
  approvalExpiresAt: null,
  reusableAsTemplate: false,
  scheduledAt: null,
  publishAttempt: 0,
  externalPostId: null,
  publishedAt: null,
  deletedAt: null,
  contentPurgedAt: null,
  legalHold: false,
  history: [],
  historyVersion: 2,
  claimIds: [],
  assetIds: [],
  claimRegistryVersion: 1,
  assetRegistryVersion: 1,
  factSnapshot: {},
  factsDigest: null,
});

test("two approvals of one version produce one row update and keep the expiry", async () => {
  await withAuditKey(async () => {
    let row = pendingPost();
    let updateCount = 0;
    let winningWrite;
    const audit = signedAudit({
      action: MARKETING_S2B1_ACTIONS.postApprove,
      targetId: row.id,
      metadata: { digest: DIGEST },
    });
    const database = {
      $queryRaw: async () => [row],
      marketingPost: {
        updateMany: async ({ data }) => {
          if (row.status !== "pending_approval") return { count: 0 };
          updateCount += 1;
          winningWrite = data;
          row = { ...row, ...data };
          return { count: 1 };
        },
      },
      adminAuditLog: auditReader(audit),
    };
    const expiry = new Date("2026-09-23T00:00:00.000Z");
    const input = {
      id: row.id,
      expectedEnvelopeDigest: DIGEST,
      expectedHistoryVersion: 2,
      approvalAuditLogId: audit.id,
      approvalExpiresAt: expiry,
    };
    const results = await Promise.allSettled([
      approveMarketingPost(database, input),
      approveMarketingPost(database, input),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(updateCount, 1);
    assert.equal(winningWrite.approvalExpiresAt.toISOString(), expiry.toISOString());
    assert.equal(winningWrite.approvedDigest, DIGEST);
  });
});

test("an edited post is approved only under its new digest", async () => {
  await withAuditKey(async () => {
    const editedDigest = "c".repeat(64);
    const row = {
      ...pendingPost(),
      envelopeDigest: editedDigest,
      historyVersion: 3,
    };
    const audit = signedAudit({
      action: MARKETING_S2B1_ACTIONS.postApprove,
      targetId: row.id,
      metadata: { digest: editedDigest },
    });
    let write;
    await approveMarketingPost(
      {
        $queryRaw: async () => [row],
        marketingPost: {
          updateMany: async ({ data }) => {
            write = data;
            return { count: 1 };
          },
        },
        adminAuditLog: auditReader(audit),
      },
      {
        id: row.id,
        expectedEnvelopeDigest: editedDigest,
        expectedHistoryVersion: 3,
        approvalAuditLogId: audit.id,
        approvalExpiresAt: new Date("2026-09-23T00:00:00.000Z"),
      },
    );
    assert.equal(write.approvedDigest, editedDigest);
  });
});

test("a reusable marking whose post moved underneath it loses the CAS", async () => {
  await withAuditKey(async () => {
    const row = {
      ...pendingPost(),
      status: "published",
      approvedDigest: DIGEST,
      publishedAt: new Date("2026-09-22T00:00:00.000Z"),
      historyVersion: 3,
    };
    const audit = signedAudit({
      action: MARKETING_S2B1_ACTIONS.postMarkReusable,
      targetId: row.id,
      metadata: { digest: DIGEST, historyVersion: 3 },
    });
    await assert.rejects(
      markMarketingPostReusable(
        {
          $queryRaw: async () => [row],
          marketingPost: { updateMany: async () => ({ count: 0 }) },
          adminAuditLog: auditReader(audit),
        },
        {
          id: row.id,
          expectedEnvelopeDigest: DIGEST,
          expectedHistoryVersion: 3,
          auditLogId: audit.id,
        },
      ),
      (error) =>
        error instanceof MarketingStoreRefusedError &&
        error.code === "mark_reusable_conflict",
    );
  });
});

test("mark reusable accepts every template-eligible state and refuses the rest", async () => {
  // The four `loadApprovedTemplate` accepts, and one it does not. An earlier
  // version of this pinned `published` alone as the only markable state, which
  // would have left a post that reached `verified` -- which the publisher does
  // on its own -- permanently unmarkable, and a template nobody can mark is an
  // autonomy path nothing can reach.
  const attempt = (status, onAudit) =>
    markMarketingPostReusable(
      {
        $queryRaw: async () => [
          {
            ...pendingPost(),
            status,
            approvedDigest: DIGEST,
            envelopeDigest: DIGEST,
            historyVersion: 3,
          },
        ],
        adminAuditLog: { findUnique: onAudit },
      },
      {
        id: "post-1",
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 3,
        auditLogId: "audit-mark",
      },
    );

  for (const status of ["approved", "scheduled", "published", "verified"]) {
    let reached = false;
    await assert.rejects(
      attempt(status, async () => {
        reached = true;
        return null;
      }),
      () => true,
      status,
    );
    assert.equal(reached, true, `${status} should have reached audit verification`);
  }

  for (const status of ["drafted", "pending_approval", "failed", "deleted"]) {
    await assert.rejects(
      attempt(status, async () => {
        throw new Error("wrong-state writes must not reach audit verification");
      }),
      (error) =>
        error instanceof MarketingStoreRefusedError &&
        error.code === "mark_reusable_conflict",
      status,
    );
  }
});

const failedPost = () => ({
  ...pendingPost(),
  status: "failed",
  historyVersion: 4,
  approvalAuditLogId: "approval-before-failure",
  approvedAt: new Date("2026-09-21T23:00:00.000Z"),
  publishAttempt: 1,
  history: [
    {
      at: "2026-09-22T00:00:00.000Z",
      type: "attempt",
      attempt: 1,
      outcome: "failed",
      errorCode: "provider_rejected",
    },
  ],
});

test("requeue refuses an audit older than the failure it answers", async () => {
  const row = failedPost();
  const oldAudit = {
    ...signedAudit({
      action: MARKETING_S2B1_ACTIONS.postRequeueAfterFailure,
      targetId: row.id,
      metadata: { digest: DIGEST },
      createdAt: new Date("2026-09-21T23:59:59.000Z"),
    }),
  };
  await assert.rejects(
    requeueMarketingPostAfterFailure(
      {
        $queryRaw: async () => [row],
        adminAuditLog: auditReader(oldAudit),
      },
      {
        id: row.id,
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 4,
        auditLogId: oldAudit.id,
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "audit_evidence_entry_predates_decision",
  );
});

test("requeue refuses reuse of the previous approval audit id", async () => {
  const row = failedPost();
  await assert.rejects(
    requeueMarketingPostAfterFailure(
      { $queryRaw: async () => [row] },
      {
        id: row.id,
        expectedEnvelopeDigest: DIGEST,
        expectedHistoryVersion: 4,
        auditLogId: row.approvalAuditLogId,
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "requeue_conflict",
  );
});

test("autonomous resume refuses a missing closed reason before database work", async () => {
  let reads = 0;
  await assert.rejects(
    resumeMarketingChannelToAutonomous(
      {
        $queryRaw: async () => {
          reads += 1;
          return [];
        },
      },
      {
        id: "channel-1",
        auditLogId: "audit-1",
        reasonCode: undefined,
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "resume_reason_invalid",
  );
  assert.equal(reads, 0);
});

test("autonomous resume refuses an audit action that fails the store check", async () => {
  const row = {
    id: "channel-1",
    channel: "linkedin",
    status: "paused",
    connectionGeneration: 1,
    scopesDigest: DIGEST,
    policyVersion: 1,
    graduationEpoch: 2,
    graduatedAt: new Date("2026-09-20T00:00:00.000Z"),
    graduationSnapshot: {},
    pausedAt: new Date("2026-09-22T00:00:00.000Z"),
    pausedFromMode: "autonomous_mode",
    pauseReasonCode: "incident_review",
    lastResumeAuditLogId: null,
    dailyCapOverride: null,
    weeklyCapOverride: null,
  };
  const wrong = {
    ...signedAudit({
      action: "marketing_account.pause",
      targetId: row.id,
      metadata: { reasonCode: "incident_resolved" },
      createdAt: new Date("2026-09-22T00:01:00.000Z"),
    }),
  };
  await assert.rejects(
    resumeMarketingChannelToAutonomous(
      {
        $queryRaw: async () => [row],
        adminAuditLog: auditReader(wrong),
      },
      {
        id: row.id,
        auditLogId: wrong.id,
        reasonCode: "incident_resolved",
      },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "resume_evidence_action_mismatch",
  );
});

test("lower-caps refuses an effective increase before issuing UPDATE", async () => {
  let updates = 0;
  const row = {
    id: "channel-1",
    channel: "linkedin",
    status: "approval_mode",
    connectionGeneration: 1,
    scopesDigest: DIGEST,
    policyVersion: 1,
    graduationEpoch: 0,
    graduatedAt: null,
    graduationSnapshot: null,
    pausedAt: null,
    pausedFromMode: null,
    pauseReasonCode: null,
    lastResumeAuditLogId: null,
    dailyCapOverride: 0,
    weeklyCapOverride: 2,
  };
  await assert.rejects(
    lowerMarketingChannelCaps(
      {
        $queryRaw: async () => [row],
        marketingChannel: {
          updateMany: async () => {
            updates += 1;
            return { count: 1 };
          },
        },
      },
      { id: row.id, dailyCapOverride: 1, weeklyCapOverride: 2 },
    ),
    (error) =>
      error instanceof MarketingStoreRefusedError &&
      error.code === "cap_change_raises_limit",
  );
  assert.equal(updates, 0);
});

test("every refusal the store can raise has an HTTP meaning", () => {
  // The route layer used to keep its own copy of this table and three of its
  // keys were misspellings -- `cap_change_is_a_no_op` for `cap_change_is_noop`,
  // `reject_conflict` for `rejection_conflict`, and one that matched nothing at
  // all -- so those conflicts went out as 422 instead of 409. Transcription is
  // what failed, so nothing transcribes any more and this fails when a new
  // refusal arrives without a status.
  const source = readFileSync(
    fileURLToPath(new URL("../lib/marketingStore.ts", import.meta.url)),
    "utf8"
  );
  const codes = new Set();
  for (const [, code] of source.matchAll(
    /MarketingStoreRefusedError\(\s*"([a-z_]+)"/g
  )) {
    codes.add(code);
  }
  for (const [, code] of source.matchAll(
    /requireOne\(\s*[A-Za-z0-9_.]+\s*,\s*"([a-z_]+)"/g
  )) {
    codes.add(code);
  }
  assert.ok(codes.size > 40, `expected the store to raise many refusals, saw ${codes.size}`);
  const missing = [...codes].filter((code) => !(code in MARKETING_REFUSAL_STATUS)).sort();
  assert.deepEqual(missing, [], "refusals with no HTTP meaning");
  const unused = Object.keys(MARKETING_REFUSAL_STATUS)
    .filter((code) => !codes.has(code))
    .sort();
  assert.deepEqual(unused, [], "statuses for refusals nothing raises");
});

test("the mutation gate reads the kill switch by the name the resolver uses", () => {
  // It read `MARKETING_AUTOPUBLISH_KILL_SWITCH`, which nothing in this
  // repository sets or reads. The only gate the slice had therefore did
  // nothing: turning the real switch on left every marketing mutation open.
  const source = readFileSync(
    fileURLToPath(new URL("../lib/marketingAdminMutations.ts", import.meta.url)),
    "utf8"
  );
  assert.match(source, /process\.env\[MARKETING_AUTOMATION_KILL_SWITCH_ENV\]/);
  assert.doesNotMatch(
    source,
    /process\.env\.[A-Z_]*KILL_SWITCH/,
    "the environment variable's name belongs to the resolver, not to a second copy"
  );
});
