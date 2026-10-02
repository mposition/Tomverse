// Every store operation the publisher runs fits the statement budget (S2 plan, S2d2).
//
// `runBoundedMarketingTransaction` refuses the statement after
// MARKETING_PUBLISHER_MAX_STATEMENTS, and a refusal rolls the transaction back.
// For most operations that is a run that did nothing. For one it is worse: the
// unknown-outcome write is also the write that pauses the autonomous account,
// so an operation over budget would fail to stop the account in exactly the
// case the stop exists for. The budget was 12 when the first caller arrived and
// that operation issued 13.
//
// So the budget is measured here rather than chosen. Each operation runs through
// the real wrapper, with its real counting proxy, against a fake that answers
// every query the operation asks on its successful path -- the longest one --
// and records every call that reaches it. The counts are pinned exactly, so the
// next statement added to any operation fails here, where the person adding it
// can decide whether the budget moves with it.
//
// What a fake cannot show is how many SQL statements Prisma sends per call; the
// budget is a count of calls, which is what the wrapper counts too.

import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { resolvePublishAdmission } from "@/lib/marketingAutonomousAdmission";
import { runBoundedMarketingTransaction } from "@/lib/marketingPublisherRun";
import { MARKETING_PUBLISHER_MAX_STATEMENTS } from "@/lib/marketingPublisherRunCore";
import {
  claimDueMarketingPost,
  listMarketingPostsPublishingPastLease,
  recordMarketingPostFailed,
  recordMarketingPostOutcomeUnknown,
  recordMarketingPostPolledPublished,
  recordMarketingPostPollRemovedByPlatform,
  recordMarketingPostPollVerified,
  recordMarketingPostPublished,
  releaseMarketingPostClaim,
  startMarketingPostDispatch,
  type MarketingAdmissionChannel,
  type MarketingTransaction,
} from "@/lib/marketingStore";
import { MARKETING_POST_AUDIT_TARGET_TYPE } from "@/lib/marketingAuditEvidence";

import {
  auditEvidenceReads,
  hashedSystemAuditRow,
  configureTestAuditIntegrityKey,
} from "./support/hashedAuditEntry";

configureTestAuditIntegrityKey();

// The autonomous insert's record, hashed and linked, so the dispatch's evidence
// check takes its full path -- three reads -- rather than refusing at the first.
const SCHEDULED = auditEvidenceReads(
  hashedSystemAuditRow({
    action: "marketing_post.autonomous_scheduled",
    systemActor: "marketing-guard",
    targetType: MARKETING_POST_AUDIT_TARGET_TYPE,
    targetId: "p1",
    metadata: {
      admissionCodeDigest: "code-digest-1",
      configGeneration: 3,
      deploymentId: "deploy-1",
    },
  }),
);

const NOW = new Date("2026-09-23T09:00:00.000Z");
const LEASE = new Date("2026-09-23T09:15:00.000Z");
const ENVELOPE = {
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Three answers to one question, side by side.",
  claimIds: ["claim.compare"],
  assets: [{ assetId: "asset.hero", altKey: "alt.hero" }],
  finalUrl: null,
  scheduledAt: "2026-09-23T09:00:00.000Z",
  disclosureFlags: [],
};

const statementText = (query: unknown): string => {
  if (Array.isArray(query)) return query.join("?");
  const strings = (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : String(query);
};

const SETUP = [/server_version_num/, /current_setting\('transaction_timeout'\)/, /set_config/];

/**
 * A client whose transaction answers the publisher's queries and counts the work.
 *
 * Every function reached on the transaction is counted, through a proxy rather
 * than a list of methods, so a delegate call this fake did not anticipate is
 * still counted rather than missed. The wrapper's own setup statements are not
 * charged to the work, as the wrapper does not charge them either.
 */
type Shape = {
  /** The post's mode, which decides the dispatch's longest path. */
  mode?: "approval" | "autonomous";
  /** Answers for successive `marketingPost.updateMany` calls; then 1. */
  postUpdates?: number[];
};

const PROVENANCE = {
  admissionCodeDigest: "code-digest-1",
  configGeneration: 3,
  deploymentId: "deploy-1",
};

const countingClient = (postStatus: string, shape: Shape = {}) => {
  const calls: string[] = [];
  const postUpdates = [...(shape.postUpdates ?? [])];
  const raw = async (query: unknown) => {
    const sql = statementText(query);
    if (sql.includes("server_version_num")) return [{ num: 170002 }];
    if (sql.includes("current_setting('transaction_timeout')")) return [{ value: "0" }];
    if (sql.includes("set_config")) return [{ set_config: "" }];
    if (sql.includes("transaction_isolation")) return [{ level: "serializable" }];
    if (sql.includes("clock_timestamp")) return [{ now: NOW, createdAt: NOW, day: "2026-09-23" }];
    if (sql.includes("count(*) FILTER")) return [{ today: BigInt(0), week: BigInt(0) }];
    if (sql.includes("SKIP LOCKED")) return [{ id: "p1", historyVersion: 4, slotDay: null }];
    if (sql.includes("logicalKey")) {
      return [
        {
          id: "p1",
          channelId: "c1",
          logicalKey: "k",
          status: postStatus,
          claimToken: "t",
          leaseUntil: LEASE,
          historyVersion: 4,
          publishAttempt: 0,
          envelope: ENVELOPE,
          mode: shape.mode ?? "approval",
          envelopeDigest: "digest-1",
          approvedDigest: "digest-1",
          approvedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
          approvalExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        },
      ];
    }
    // Every other read of a post: the outcome writers and the three polls.
    if (sql.includes('FROM "MarketingPost"')) {
      return [
        {
          id: "p1",
          channelId: "c1",
          status: postStatus,
          providerRequestKey: "k",
          publishAttempt: 1,
          history: [],
          historyVersion: 4,
          claimToken: "t",
          leaseUntil: LEASE,
        },
      ];
    }
    if (sql.includes("FOR UPDATE")) {
      return [
        {
          id: "c1",
          channel: "linkedin",
          status: "autonomous_mode",
          connectionGeneration: 1,
          dailyCapOverride: null,
          weeklyCapOverride: null,
          externalAccountRef: "acct_9",
        },
      ];
    }
    return [];
  };
  const answers: Record<string, Record<string, (...args: never[]) => unknown>> = {
    marketingChannel: {
      findUnique: () => ({ id: "c1" }),
      updateMany: () => ({ count: 1 }),
    },
    marketingPost: {
      updateMany: () => ({ count: postUpdates.length > 0 ? postUpdates.shift() : 1 }),
      findMany: () => [],
    },
    adminAuditLog: {
      // The chain's own tail lookup answers null; the dispatch reading back an
      // autonomous post's admission answers with the provenance it compares.
      findFirst: (args?: never) => SCHEDULED(args) ?? null,
      create: ({ data }: { data: unknown }) => data,
    },
  };
  const counted = (name: string, fn: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      const sql = name.startsWith("$") ? statementText(args[0]) : "";
      if (!SETUP.some((pattern) => pattern.test(sql))) calls.push(name);
      return fn(...args);
    };
  const tx = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "$queryRaw" || key === "$executeRaw") {
          return counted(String(key), (query) => (key === "$queryRaw" ? raw(query) : 0));
        }
        if (typeof key !== "string" || key === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_inner, method) {
              const answer = answers[key]?.[String(method)];
              return counted(`${key}.${String(method)}`, (...args) => {
                if (!answer) throw new Error(`unanticipated call ${key}.${String(method)}`);
                return (answer as (...a: unknown[]) => unknown)(...args);
              });
            },
          },
        );
      },
    },
  );
  const client = {
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(tx);
    },
  };
  return { client: client as unknown as PrismaClient, calls };
};

/**
 * The real resolver's reads, with its answer forced to "publish".
 *
 * The resolver reads settings inside the transaction, and those reads are
 * statements; a stub would leave them out of the count. Its answer is forced
 * because a refusal ends the operation early, and the count wanted is the
 * longest path, not the shortest.
 */
const realResolverAdmitting = async (
  database: MarketingTransaction,
  channel: MarketingAdmissionChannel,
  postMode?: "approval" | "autonomous",
) => {
  // The resolver the publisher's claim and dispatch actually use, including its
  // own read of the database clock.
  const answer = await resolvePublishAdmission(database, channel, null, postMode);
  return { ...answer, ...PROVENANCE, publish: true };
};

const measure = async (
  postStatus: string,
  work: (tx: MarketingTransaction) => Promise<unknown>,
  shape: Shape = {},
) => {
  const { client, calls } = countingClient(postStatus, shape);
  const result = (await runBoundedMarketingTransaction(client, (tx) =>
    work(tx as MarketingTransaction),
  )) as Record<string, unknown>;
  // The count is only the longest path if the operation took it. A refusal is a
  // shorter path, and pinning its count would pin the wrong number.
  const succeeded =
    Array.isArray(result) ||
    ["claimed", "released", "started", "recorded"].some((key) => result[key] === true);
  assert.ok(succeeded, `the operation took a refusal path: ${JSON.stringify(result)}`);
  return { calls, result };
};

/**
 * The measured counts. A change here is a change to what the publisher spends,
 * and the headroom test below says whether it still fits.
 */
const OPERATIONS: ReadonlyArray<{
  name: string;
  expected: number;
  postStatus: string;
  shape?: Shape;
  run: (tx: MarketingTransaction) => Promise<unknown>;
}> = [
  {
    // The longest claim: the post was held by a worker whose lease ran out, so
    // the first conditional write finds nothing and the reclaim writes it. The
    // round-1 review found this path uncounted.
    name: "claim, reclaiming an expired lease",
    expected: 14,
    postStatus: "scheduled",
    shape: { postUpdates: [0, 1] },
    run: (tx) =>
      claimDueMarketingPost(tx, {
        channelId: "c1",
        claimToken: "t",
        resolveAdmission: realResolverAdmitting,
      }),
  },
  {
    // The longest dispatch: an autonomous post, which also reads back the
    // admission it was scheduled under.
    name: "dispatch, autonomous",
    expected: 15,
    postStatus: "scheduled",
    shape: { mode: "autonomous" },
    run: (tx) =>
      startMarketingPostDispatch(tx, {
        id: "p1",
        claimToken: "t",
        expectedLeaseUntil: LEASE,
        expectedHistoryVersion: 4,
        runDeadlineAt: new Date("2026-09-23T09:04:00.000Z"),
        callBudgetMs: 30_000,
        resolveAdmission: realResolverAdmitting,
      }),
  },
  {
    name: "list dead dispatches",
    expected: 1,
    postStatus: "publishing",
    run: (tx) => listMarketingPostsPublishingPastLease(tx, { before: NOW, limit: 10 }),
  },
  {
    name: "claim",
    expected: 13,
    postStatus: "scheduled",
    run: (tx) =>
      claimDueMarketingPost(tx, {
        channelId: "c1",
        claimToken: "t",
        resolveAdmission: realResolverAdmitting,
      }),
  },
  {
    name: "release claim",
    expected: 6,
    postStatus: "scheduled",
    run: (tx) =>
      releaseMarketingPostClaim(tx, {
        id: "p1",
        claimToken: "t",
        expectedLeaseUntil: LEASE,
        expectedHistoryVersion: 4,
        reason: "no_longer_admitted",
      }),
  },
  {
    name: "dispatch",
    expected: 12,
    postStatus: "scheduled",
    run: (tx) =>
      startMarketingPostDispatch(tx, {
        id: "p1",
        claimToken: "t",
        expectedLeaseUntil: LEASE,
        expectedHistoryVersion: 4,
        runDeadlineAt: new Date("2026-09-23T09:04:00.000Z"),
        callBudgetMs: 30_000,
        resolveAdmission: realResolverAdmitting,
      }),
  },
  {
    name: "published",
    expected: 9,
    postStatus: "publishing",
    run: (tx) =>
      recordMarketingPostPublished(tx, {
        id: "p1",
        requestKey: "k",
        expectedHistoryVersion: 4,
        externalPostId: "urn:li:share:7100",
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
      }),
  },
  {
    name: "failed",
    expected: 9,
    postStatus: "publishing",
    run: (tx) =>
      recordMarketingPostFailed(tx, {
        id: "p1",
        requestKey: "k",
        expectedHistoryVersion: 4,
        errorCode: "zernio_rejected",
      }),
  },
  {
    name: "outcome_unknown (pauses the account)",
    expected: 15,
    postStatus: "publishing",
    // The longest path: the post is written and the autonomous account paused.
    run: (tx) =>
      recordMarketingPostOutcomeUnknown(tx, {
        id: "p1",
        requestKey: "k",
        expectedHistoryVersion: 4,
        errorCode: "zernio_no_answer",
      }),
  },
  {
    name: "poll published",
    expected: 9,
    postStatus: "publishing",
    run: (tx) =>
      recordMarketingPostPolledPublished(tx, {
        id: "p1",
        requestKey: "k",
        expectedHistoryVersion: 4,
        externalPostId: "urn:li:share:7100",
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:7100",
      }),
  },
  {
    name: "poll verified",
    expected: 9,
    postStatus: "published",
    run: (tx) =>
      recordMarketingPostPollVerified(tx, {
        id: "p1",
        expectedHistoryVersion: 4,
        verificationMethod: "status_query",
      }),
  },
  {
    name: "poll removed by platform",
    expected: 8,
    postStatus: "published",
    run: (tx) =>
      recordMarketingPostPollRemovedByPlatform(tx, {
        id: "p1",
        expectedHistoryVersion: 4,
        evidence: "status_query_not_found",
      }),
  },
];

for (const operation of OPERATIONS) {
  test(`${operation.name} issues the measured number of statements`, async () => {
    const { calls } = await measure(operation.postStatus, operation.run, operation.shape);
    assert.equal(
      calls.length,
      operation.expected,
      `${operation.name} now issues ${calls.length} statements:\n  ${calls.join("\n  ")}`,
    );
  });
}

test("every publisher operation fits the budget with room to spare", () => {
  // Three statements of headroom over the worst case: enough that one more audit
  // field or one more read does not silently turn the safety pause into a
  // rollback, and few enough that the derived maximum stays a figure someone
  // chose rather than a ceiling nobody approaches.
  const worst = Math.max(...OPERATIONS.map((operation) => operation.expected));
  assert.ok(
    worst + 3 <= MARKETING_PUBLISHER_MAX_STATEMENTS,
    `the worst operation issues ${worst}; the budget is ${MARKETING_PUBLISHER_MAX_STATEMENTS}`,
  );
});
