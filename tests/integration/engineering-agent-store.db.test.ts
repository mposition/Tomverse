import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Session } from "next-auth";

import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import { unknownOutcomeDecisionCauseKey } from "@/lib/engineeringAgentCore";
import {
  ENGINEERING_AGENT_AUDIT_ACTIONS,
  EngineeringAgentStoreRefusedError,
  acceptEngineeringAgentRequest,
  acknowledgeEngineeringAgentDecision,
  acknowledgeEngineeringAgentHalt,
  currentEngineeringAgentHalt,
  recordEngineeringAgentObservedHalt,
  readEngineeringAgentKnownPublishes,
  readEngineeringAgentHaltState,
  claimEngineeringAgentWorkItem,
  claimNextEngineeringAgentPublishWork,
  decideEngineeringAgentT2Draft,
  endEngineeringAgentRun,
  heartbeatEngineeringAgentRun,
  issueEngineeringAgentCapability,
  moveEngineeringAgentBinding,
  moveEngineeringAgentRequest,
  openEngineeringAgentWorkItem,
  recordEngineeringAgentBinding,
  recordEngineeringAgentBindingObservation,
  readEngineeringAgentOwnerQueues,
  recordEngineeringAgentMonitorsConfirmed,
  recordEngineeringAgentRunStart,
  recordEngineeringAgentServiceFinish,
  removeEngineeringAgentReviewer,
  replaceEngineeringAgentBinding,
  runEngineeringAgentTransaction,
  setEngineeringAgentSwitch,
  settleEngineeringAgentWorkItem,
} from "@/lib/engineeringAgentStore";
import { readEngineeringAgentLastLook } from "@/lib/engineeringAgentLastLook";
import { openEngineeringAgentV22Product } from "@/lib/engineeringAgentV22ProductStore";
import { runIdempotentEngineeringAgentRequest } from "@/lib/engineeringAgentRouteAuth";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for the engineering agent's single writer
// (docs/policy/engineering-agent.md §11): every change commits with its audit
// entry under the right actor, results go where the core says, and the
// database's own rules still hold behind the store. A missing
// TEST_DATABASE_URL means this file was not executed, not that it passed.
//
// It does not depend on file order: engineering-agent-schema.db.test.ts may
// run first and leave the first T1 window open (one pull request at a time),
// so every test here closes what it opens -- runs ended, publish items
// settled, bindings pruned, decisions acknowledged -- before the next starts.

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: engineering agent DB tests require DATABASE_URL=TEST_DATABASE_URL");
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(databaseName) || url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: engineering agent DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

const fixtureTaskIds: string[] = [];
const MODE_KEY = "feature.engineeringAgentMode";
const FREEZE_KEY = "feature.engineeringAgentFreeze";

// A run is a claim, and there is none while the mode is off (the run trigger);
// a publish needs mode t1 and a run that started under it.
before(async () => {
  await prisma.appSetting.upsert({ where: { key: MODE_KEY }, create: { key: MODE_KEY, value: "t1" }, update: { value: "t1" } });
  await prisma.appSetting.deleteMany({ where: { key: FREEZE_KEY } });
});

after(async () => {
  await prisma.appSetting.deleteMany({ where: { key: MODE_KEY } });
  if (fixtureTaskIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: fixtureTaskIds } }, data: { archivedAt: new Date() } });
  }
  await prisma.$disconnect();
});

const sha1 = (seed: string) => createHash("sha1").update(seed).digest("hex");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
let runCounter = 500_000_000 + (Math.floor(Date.now() / 1000) % 100_000_000);
const nextRunId = () => String((runCounter += 1));

const inTx = <T>(work: Parameters<typeof runEngineeringAgentTransaction<T>>[1]) =>
  runEngineeringAgentTransaction(prisma, work);

const refusedWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof EngineeringAgentStoreRefusedError && error.code === code, code);

const amuxAttempt = async () => {
  const task = await prisma.amuxWorkItem.create({
    data: {
      id: `eng-agent-card-${randomUUID()}`,
      title: "Engineering agent store fixture",
      status: "review",
      kind: "code",
      priority: "p3",
      revision: 2,
      requiresHumanReview: true,
      reviewSpecialty: "code-review",
      reviewPrNumber: 1706,
    },
  });
  fixtureTaskIds.push(task.id);
  const now = new Date();
  // An attempt still running: a run on an attempt AMUX has already ended is
  // an orphaned run, and that halts the agent (§11) -- which is not what these
  // tests are about.
  const attempt = await prisma.amuxExecutionAttempt.create({
    data: {
      id: `eng-agent-attempt-${randomUUID()}`,
      taskId: task.id,
      worker: "engineering-runner",
      workerInstanceId: "store-fixture",
      workerGeneration: 1,
      taskRevision: 1,
      attemptNumber: 1,
      heartbeatAt: now,
      startedAt: now,
      leaseExpiresAt: new Date(now.getTime() + 60 * 60_000),
    },
  });
  return { task, attempt };
};

const startRun = async () => {
  const { task, attempt } = await amuxAttempt();
  const runId = nextRunId();
  const started = await inTx((tx) =>
    recordEngineeringAgentRunStart(tx, {
      runId,
      amuxAttemptId: attempt.id,
      cardId: task.id,
      cardKind: "code",
      baseSha: sha1("base"),
      leaseMs: 60_000,
    }),
  );
  return { ...started, cardId: task.id, amuxAttemptId: attempt.id };
};

const auditFor = (targetId: string) =>
  prisma.adminAuditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" } });

const systemActorOf = (row: { metadata: unknown }) =>
  (row.metadata as Record<string, unknown> | null)?.[SYSTEM_AUDIT_ACTOR_METADATA_KEY];

const owner = {
  user: { id: `eng-agent-owner-${randomUUID()}`, email: "owner@example.test" },
  expires: new Date(Date.now() + 3_600_000).toISOString(),
} as Session;

test("a request is recorded before its work and answered from its record after", async () => {
  const key = randomUUID().replace(/-/g, "");
  const digest = sha256("request");
  assert.deepEqual(await inTx((tx) => acceptEngineeringAgentRequest(tx, { key, route: "run/start", requestDigest: digest })), {
    outcome: "accepted",
  });
  assert.deepEqual(await inTx((tx) => acceptEngineeringAgentRequest(tx, { key, route: "run/start", requestDigest: digest })), {
    outcome: "replay",
    state: "accepted",
    resultRef: null,
  });
  assert.deepEqual(
    await inTx((tx) => acceptEngineeringAgentRequest(tx, { key, route: "run/start", requestDigest: sha256("other") })),
    { outcome: "conflict" },
  );
  await inTx((tx) => moveEngineeringAgentRequest(tx, { key, from: "accepted", to: "in_progress" }));
  await refusedWith(
    inTx((tx) => moveEngineeringAgentRequest(tx, { key, from: "accepted", to: "in_progress" })),
    "request_not_in_expected_state",
  );
  await inTx((tx) => moveEngineeringAgentRequest(tx, { key, from: "in_progress", to: "committed" }));
});

test("a run starts and ends with its audit entries, under the runner", async () => {
  const run = await startRun();
  assert.equal(run.modeAtStart, "t1");
  const extended = await inTx((tx) => heartbeatEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, leaseMs: 120_000 }));
  assert.ok(extended.getTime() > run.leaseExpiresAt.getTime());
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "no_change", halt: "none" }));
  await refusedWith(
    inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "no_change", halt: "none" })),
    "run_not_active",
  );
  const entries = await auditFor(run.runId);
  assert.deepEqual(
    entries.map((entry) => entry.action),
    [ENGINEERING_AGENT_AUDIT_ACTIONS.runStarted, ENGINEERING_AGENT_AUDIT_ACTIONS.runEnded],
  );
  for (const entry of entries) {
    assert.equal(systemActorOf(entry), "engineering-agent-runner");
    assert.equal(entry.actorUserId, null);
  }
});

const bindingInput = (runId: string, prNumber = 100_000 + Math.floor(Math.random() * 800_000)) => ({
  runId,
  prNumber,
  headSha: sha1("head"),
  verifiedHeadSha: sha1("head"),
  snapshot: { baseSha: sha1("base"), diffDigest: sha256("diff"), treeId: sha1("tree"), invalidatedReviewIds: [] as number[] },
});

/**
 * Settles a write claim as confirmed and binds the pull request in the same
 * transaction: a publish item leaves the queue's count only for its binding.
 */
const settleAndBind = async (workItemId: string, fencingToken: bigint, runId: string, prNumber?: number) =>
  inTx(async (tx) => {
    const settled = await settleEngineeringAgentWorkItem(tx, { workItemId, fencingToken, outcome: "confirmed" });
    assert.equal(settled.state, "published");
    return recordEngineeringAgentBinding(tx, bindingInput(runId, prNumber));
  });

/** Closes and prunes a binding, so the pull request queue has room again. */
const retireBinding = async (bindingId: string) => {
  await inTx((tx) => moveEngineeringAgentBinding(tx, { bindingId, to: "closed" }));
  await inTx((tx) => moveEngineeringAgentBinding(tx, { bindingId, to: "pruned" }));
};

/** Opens a run's publish item, publishes it and binds the pull request, as the publisher would. */
const publishFor = async (run: { runId: string; cardId: string }, prNumber: number) => {
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "publish",
      causeKey: `publish:${run.runId}:bound`,
      runId: run.runId,
      patchBody: "patch",
      patchDigest: sha256("patch"),
      baseSha: sha1("base"),
      expectedTreeId: sha1("tree"),
    }),
  );
  await inTx((tx) =>
    issueEngineeringAgentCapability(tx, {
      workItemId,
      capability: { baseSha: sha1("base"), patchDigest: sha256("patch"), expectedTreeId: sha1("tree"), commit: commitFields(run.runId, run.cardId) },
    }),
  );
  const claim = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));
  return settleAndBind(workItemId, claim.fencingToken, run.runId, prNumber);
};

const commitFields = (runId: string, cardRef: string) => ({
  identity: { name: "Tomverse Engineering Agent", email: "engineering-agent@users.noreply.github.com" },
  baseCommitterDate: "1759000000 +1000",
  runId,
  cardRef,
});

test("v22 publish and its capability commit together, or neither commits", async () => {
  const run = await startRun();
  const patch = { text: "patch", sha256: sha256("patch"), baseSha: sha1("base") };
  const product = await inTx((tx) => openEngineeringAgentV22Product(tx, {
    runId: run.runId, taskId: run.cardId, patch, publish: true,
    candidate: { expectedTreeId: sha1("tree"),
      baseCommitterDate: "1759000000 +1000" },
  }));
  assert.equal(product.kind, "publish");
  const capability = await prisma.engineeringAgentCapability.findFirstOrThrow({
    where: { unconsumedWorkItemId: product.id },
  });
  assert.equal(capability.consumedAt, null);
  const claim = await inTx((tx) => claimEngineeringAgentWorkItem(tx, {
    workItemId: product.id, mode: "write", leaseMs: 60_000,
  }));
  const bound = await settleAndBind(product.id, claim.fencingToken, run.runId);
  await inTx((tx) => endEngineeringAgentRun(tx, {
    runId: run.runId, amuxAttemptId: run.amuxAttemptId,
    outcome: "t1_queued", halt: "none",
  }));
  await retireBinding(bound.bindingId);

  const rejectedRun = await startRun();
  await assert.rejects(
    inTx((tx) => openEngineeringAgentV22Product(tx, {
      runId: rejectedRun.runId, taskId: rejectedRun.cardId,
      patch, publish: true,
      candidate: { expectedTreeId: sha1("tree"),
        baseCommitterDate: "1759000000 +1000" },
    }, { open: openEngineeringAgentWorkItem,
      issue: async () => { throw new Error("injected_capability_failure"); } })),
    /injected_capability_failure/,
  );
  assert.equal(await prisma.engineeringAgentWorkItem.count({
    where: { causeKey: `publish:${rejectedRun.runId}` },
  }), 0);
  await inTx((tx) => endEngineeringAgentRun(tx, {
    runId: rejectedRun.runId, amuxAttemptId: rejectedRun.amuxAttemptId,
    outcome: "no_change", halt: "none",
  }));
});

test("a publish consumes its one capability on the write claim, and settles where the core says", async () => {
  const run = await startRun();
  const patchDigest = sha256("patch");
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "publish",
      causeKey: `publish:${run.runId}`,
      runId: run.runId,
      patchBody: "patch",
      patchDigest,
      baseSha: sha1("base"),
      expectedTreeId: sha1("tree"),
    }),
  );
  await refusedWith(
    inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 })),
    "capability_unavailable",
  );
  const issued = await inTx((tx) =>
    issueEngineeringAgentCapability(tx, {
      workItemId,
      capability: {
        baseSha: sha1("base"),
        patchDigest,
        expectedTreeId: sha1("tree"),
        commit: commitFields(run.runId, run.cardId),
      },
    }),
  );
  assert.match(issued.commitDigest, /^[0-9a-f]{64}$/);

  const claim = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));
  assert.equal(claim.fencingToken, BigInt(1));
  const capability = await prisma.engineeringAgentCapability.findUniqueOrThrow({ where: { id: issued.capabilityId } });
  assert.ok(capability.consumedAt, "the write claim consumed the capability");
  assert.equal(capability.claimFencingToken, BigInt(1));
  assert.equal(capability.unconsumedWorkItemId, null, "a consumed capability is no longer the item's live one");

  await refusedWith(
    inTx((tx) =>
      settleEngineeringAgentWorkItem(tx, { workItemId, fencingToken: BigInt(9), outcome: "confirmed" }),
    ),
    "result_leads_nowhere",
  );
  // A publish committed without its binding would free a place in the pull
  // request queue for a pull request that exists; the database refuses it.
  await assert.rejects(
    inTx((tx) => settleEngineeringAgentWorkItem(tx, { workItemId, fencingToken: claim.fencingToken, outcome: "confirmed" })),
    /published without its binding/,
  );
  const bound = await settleAndBind(workItemId, claim.fencingToken, run.runId);

  const actions = (await auditFor(workItemId)).map((entry) => [entry.action, systemActorOf(entry)]);
  assert.deepEqual(actions, [
    [ENGINEERING_AGENT_AUDIT_ACTIONS.workItemOpened, "engineering-agent-runner"],
    [ENGINEERING_AGENT_AUDIT_ACTIONS.capabilityIssued, "engineering-agent-runner"],
    [ENGINEERING_AGENT_AUDIT_ACTIONS.workItemClaimed, "engineering-agent-publisher"],
    [ENGINEERING_AGENT_AUDIT_ACTIONS.workItemSettled, "engineering-agent-publisher"],
  ]);
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "none" }));
  await retireBinding(bound.bindingId);
});

test("an unknown outcome opens its decision item, and a person acknowledges it", async () => {
  const run = await startRun();
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, { kind: "expire_close", causeKey: `expire_close:${run.runId}`, runId: run.runId }),
  );
  await refusedWith(
    inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 })),
    "precondition_missing",
  );
  const claim = await inTx((tx) =>
    claimEngineeringAgentWorkItem(tx, {
      workItemId,
      mode: "write",
      leaseMs: 60_000,
      precondition: { kind: "expire_close", bindingMatches: true, stillExpired: true },
    }),
  );
  const settled = await inTx((tx) =>
    settleEngineeringAgentWorkItem(tx, { workItemId, fencingToken: claim.fencingToken, outcome: "lookup_impossible" }),
  );
  assert.equal(settled.state, "outcome_unknown");
  assert.ok(settled.decisionItemId);
  const decision = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: settled.decisionItemId! } });
  assert.equal(decision.causeKey, unknownOutcomeDecisionCauseKey(workItemId, claim.fencingToken));
  assert.equal(decision.state, "open");

  const { auditLogId } = await inTx((tx) =>
    acknowledgeEngineeringAgentDecision(tx, { session: owner, workItemId: settled.decisionItemId! }),
  );
  const entry = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: auditLogId } });
  assert.equal(entry.actorUserId, owner.user!.id);
  assert.equal(systemActorOf(entry), undefined, "a person's action is not a system entry");
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "none" }));
});

test("a T2 draft is stored only when clean, and decided with its audit entry in one transaction", async () => {
  const run = await startRun();
  // Built at run time so no secret scanner reads a key in this file.
  const leaky = `diff --git a/x b/x\n+${"-----BEGIN "}${"PRIVATE KEY-----"}\n`;
  await refusedWith(
    inTx((tx) =>
      openEngineeringAgentWorkItem(tx, {
        kind: "t2_draft",
        causeKey: `t2_draft:${run.runId}:leaky`,
        runId: run.runId,
        patchBody: leaky,
        patchDigest: sha256(leaky),
        baseSha: sha1("base"),
        reason: "push_forbidden",
      }),
    ),
    "secret_detected",
  );
  assert.equal(await prisma.engineeringAgentWorkItem.count({ where: { causeKey: `t2_draft:${run.runId}:leaky` } }), 0);

  const patch = "diff --git a/README.md b/README.md\n+one line\n";
  await refusedWith(
    inTx((tx) =>
      openEngineeringAgentWorkItem(tx, {
        kind: "t2_draft",
        causeKey: `t2_draft:${run.runId}:mismatch`,
        runId: run.runId,
        patchBody: patch,
        patchDigest: sha256("something else"),
        baseSha: sha1("base"),
        reason: "push_forbidden",
      }),
    ),
    "patch_digest_mismatch",
  );
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "t2_draft",
      causeKey: `t2_draft:${run.runId}`,
      runId: run.runId,
      patchBody: patch,
      patchDigest: sha256(patch),
      baseSha: sha1("base"),
      reason: "push_forbidden",
    }),
  );
  await refusedWith(
    inTx((tx) =>
      decideEngineeringAgentT2Draft(tx, {
        session: owner,
        workItemId,
        decision: "approved",
        patchDigest: sha256("what the owner did not see"),
        baseSha: sha1("base"),
      }),
    ),
    "draft_changed",
  );
  const decided = await inTx((tx) =>
    decideEngineeringAgentT2Draft(tx, {
      session: owner,
      workItemId,
      decision: "approved",
      patchDigest: sha256(patch),
      baseSha: sha1("base"),
    }),
  );
  const item = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: workItemId } });
  assert.equal(item.state, "approved");
  const approval = await prisma.engineeringAgentApproval.findUniqueOrThrow({ where: { id: decided.approvalId } });
  assert.equal(approval.auditLogId, decided.auditLogId);
  assert.equal(approval.actorUserId, owner.user!.id);
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t2_draft", halt: "none" }));
});

test("a binding records its observations once, its reviewer as a pair, and a re-bind supersedes it", async () => {
  const run = await startRun();
  const prNumber = 100_000 + Math.floor(Math.random() * 800_000);
  const snapshot = { baseSha: sha1("base"), diffDigest: sha256("diff"), treeId: sha1("tree"), invalidatedReviewIds: [] };
  const { bindingId } = await publishFor(run, prNumber);
  await refusedWith(
    inTx((tx) =>
      recordEngineeringAgentBinding(tx, {
        runId: run.runId,
        prNumber,
        headSha: sha1("head"),
        verifiedHeadSha: sha1("head"),
        snapshot: { ...snapshot, reviewer: "someone" } as typeof snapshot,
      }),
    ),
    "snapshot_invalid",
  );

  const { bindingId: current } = await inTx((tx) =>
    replaceEngineeringAgentBinding(tx, {
      previousBindingId: bindingId,
      replacement: {
        runId: run.runId,
        prNumber,
        headSha: sha1("head 2"),
        verifiedHeadSha: sha1("head 2"),
        snapshot: { ...snapshot, diffDigest: sha256("diff 2"), invalidatedReviewIds: [41] },
      },
    }),
  );
  const superseded = await prisma.engineeringAgentBinding.findUniqueOrThrow({ where: { id: bindingId } });
  assert.ok(superseded.supersededAt && superseded.supersededAt.getFullYear() > 2000, "the database wrote the time");

  const approved = {
    verdict: "approved" as const,
    reviewId: 42,
    reviewCommitId: sha1("head 2"),
    submittedAt: "2026-09-28T01:02:03.000Z",
    observedAt: "2026-09-28T01:03:03.000Z",
  };
  await refusedWith(
    inTx((tx) =>
      recordEngineeringAgentBindingObservation(tx, { bindingId: current, kind: "approval", observation: approved, reviewer: null }),
    ),
    "reviewer_goes_with_approval",
  );
  const reviewer = { githubId: 60078951, login: "mposition" };
  assert.deepEqual(
    await inTx((tx) =>
      recordEngineeringAgentBindingObservation(tx, { bindingId: current, kind: "approval", observation: approved, reviewer }),
    ),
    { recorded: true },
  );
  assert.deepEqual(
    await inTx((tx) =>
      recordEngineeringAgentBindingObservation(tx, { bindingId: current, kind: "approval", observation: approved, reviewer }),
    ),
    { recorded: false },
    "the same observation again is a no-op",
  );
  await refusedWith(
    inTx((tx) =>
      recordEngineeringAgentBindingObservation(tx, {
        bindingId: current,
        kind: "approval",
        observation: { verdict: "not_approved", reason: "snapshot_changed", observedAt: "2026-09-28T01:04:03.000Z" },
        reviewer: null,
      }),
    ),
    "observation_already_recorded",
  );

  await inTx((tx) => moveEngineeringAgentBinding(tx, { bindingId: current, to: "closed" }));
  await inTx((tx) =>
    recordEngineeringAgentBindingObservation(tx, {
      bindingId: current,
      kind: "merge",
      observation: {
        merged: true,
        mergeCommitSha: sha1("merge"),
        mergedAt: "2026-09-28T02:00:00.000Z",
        mergedByKind: "user",
        observedAt: "2026-09-28T02:01:00.000Z",
      },
    }),
  );
  await inTx((tx) => removeEngineeringAgentReviewer(tx, { bindingId: current }));
  const kept = await prisma.engineeringAgentBinding.findUniqueOrThrow({ where: { id: current } });
  assert.equal(kept.reviewerGithubId, null);
  assert.equal(kept.reviewerLogin, null);
  assert.ok(kept.reviewerRecordedAt, "when the reviewer was recorded stays");
  await inTx((tx) => moveEngineeringAgentBinding(tx, { bindingId: current, to: "pruned" }));

  const observers = (await auditFor(current)).map((entry) => systemActorOf(entry));
  assert.ok(observers.includes("engineering-agent-observer"));
  assert.ok(observers.includes("engineering-agent-retention"));
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "none" }));
});

test("work proven unwritten returns to the queue, and its next claim runs on a new capability", async () => {
  const run = await startRun();
  const patchDigest = sha256("patch");
  const issue = (workItemId: string) =>
    inTx((tx) =>
      issueEngineeringAgentCapability(tx, {
        workItemId,
        capability: {
          baseSha: sha1("base"),
          patchDigest,
          expectedTreeId: sha1("tree"),
          commit: commitFields(run.runId, run.cardId),
        },
      }),
    );
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "publish",
      causeKey: `publish:${run.runId}:requeue`,
      runId: run.runId,
      patchBody: "patch",
      patchDigest,
      baseSha: sha1("base"),
      expectedTreeId: sha1("tree"),
    }),
  );
  const first = await issue(workItemId);
  await refusedWith(issue(workItemId), "capability_already_live");
  const claim = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));
  // The last look refused before anything was written: back to the queue.
  const requeued = await inTx((tx) =>
    settleEngineeringAgentWorkItem(tx, { workItemId, fencingToken: claim.fencingToken, outcome: "refused_before_write" }),
  );
  assert.equal(requeued.state, "queued");
  const spent = await prisma.engineeringAgentCapability.findUniqueOrThrow({ where: { id: first.capabilityId } });
  assert.ok(spent.consumedAt, "the first capability stays consumed");

  const second = await issue(workItemId);
  assert.notEqual(second.capabilityId, first.capabilityId);
  const again = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));
  assert.equal(again.fencingToken, BigInt(2));
  const bound = await settleAndBind(workItemId, again.fencingToken, run.runId);
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "none" }));
  await retireBinding(bound.bindingId);
});

test("the switches refuse claims, capabilities and publishes, but never the record of what happened", async () => {
  const killSwitch = "ENGINEERING_AGENT_KILL_SWITCH";
  const previous = process.env[killSwitch];
  process.env[killSwitch] = "1";
  try {
    await refusedWith(startRun(), "switch_refused_claimAllowed");
  } finally {
    if (previous === undefined) delete process.env[killSwitch];
    else process.env[killSwitch] = previous;
  }

  const run = await startRun();
  const setMode = (value: string) =>
    prisma.appSetting.update({ where: { key: MODE_KEY }, data: { value } });
  await setMode("shadow");
  try {
    await refusedWith(
      inTx((tx) =>
        openEngineeringAgentWorkItem(tx, {
          kind: "publish",
          causeKey: `publish:${run.runId}:shadow`,
          runId: run.runId,
          patchBody: "patch",
          patchDigest: sha256("patch"),
          baseSha: sha1("base"),
          expectedTreeId: sha1("tree"),
        }),
      ),
      "switch_refused_publishAllowed",
    );
  } finally {
    await setMode("t1");
  }
  // Ending the run records what happened; no switch refuses it.
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "no_change", halt: "none" }));
});

test("the publisher claims its next work, and the last look can only refuse", async () => {
  const run = await startRun();
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "publish",
      causeKey: `publish:${run.runId}:route`,
      runId: run.runId,
      patchBody: "patch",
      patchDigest: sha256("patch"),
      baseSha: sha1("base"),
      expectedTreeId: sha1("tree"),
    }),
  );
  const issued = await inTx((tx) =>
    issueEngineeringAgentCapability(tx, {
      workItemId,
      capability: { baseSha: sha1("base"), patchDigest: sha256("patch"), expectedTreeId: sha1("tree"), commit: commitFields(run.runId, run.cardId) },
    }),
  );
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "none" }));

  const work = await inTx((tx) => claimNextEngineeringAgentPublishWork(tx, { leaseMs: 60_000 }));
  assert.ok(work && work.mode === "write", "a queued item with a live capability is claimed to write");
  assert.equal(work.workItemId, workItemId);
  assert.equal(work.patchBody, "patch");
  assert.equal(work.commitDigest, issued.commitDigest);
  assert.equal(work.branch, `agent/engineering/${run.runId}`);
  assert.equal(await inTx((tx) => claimNextEngineeringAgentPublishWork(tx, { leaseMs: 60_000 })), null, "nothing else to do");

  const look = (fencingToken: bigint, commitDigest: string) =>
    readEngineeringAgentLastLook(prisma, { workItemId, fencingToken, commitDigest });
  const incidentKey = "amux.incidentMode";
  const previous = await prisma.appSetting.findUnique({ where: { key: incidentKey } });
  try {
    await prisma.appSetting.deleteMany({ where: { key: incidentKey } });
    assert.deepEqual(await look(work.fencingToken, work.commitDigest), { verdict: "refuse", reason: "amux_incident" }, "no incident reading blocks");
    const normal = JSON.stringify({
      version: 1,
      state: "normal",
      transition_id: null,
      changed_at: new Date().toISOString(),
      reason: "engineering agent store fixture",
      ticket: "TEST",
    });
    await prisma.appSetting.create({ data: { key: incidentKey, value: normal } });
    assert.deepEqual(await look(work.fencingToken + BigInt(1), work.commitDigest), { verdict: "refuse", reason: "stale_fencing_token" });
    assert.deepEqual(await look(work.fencingToken, sha256("another commit")), { verdict: "refuse", reason: "commit_digest_mismatch" });
    assert.deepEqual(await look(work.fencingToken, work.commitDigest), { verdict: "no_objection" });
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: incidentKey } });
    if (previous) await prisma.appSetting.create({ data: { key: incidentKey, value: previous.value } });
  }
  const bound = await settleAndBind(workItemId, work.fencingToken, run.runId);
  await retireBinding(bound.bindingId);
});

test("a halt holds until a person acknowledges it, and stops runs and write claims before they spend", async () => {
  const ackKey = "engineeringAgent.haltAcknowledgedAt";
  const acknowledge = (value: string) =>
    prisma.appSetting.upsert({ where: { key: ackKey }, create: { key: ackKey, value }, update: { value } });
  await acknowledge(new Date().toISOString());

  const run = await startRun();
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "publish",
      causeKey: `publish:${run.runId}:halt`,
      runId: run.runId,
      patchBody: "patch",
      patchDigest: sha256("patch"),
      baseSha: sha1("base"),
      expectedTreeId: sha1("tree"),
    }),
  );
  const issued = await inTx((tx) =>
    issueEngineeringAgentCapability(tx, {
      workItemId,
      capability: { baseSha: sha1("base"), patchDigest: sha256("patch"), expectedTreeId: sha1("tree"), commit: commitFields(run.runId, run.cardId) },
    }),
  );
  // The run records a halt only the runner can see. It holds from here on.
  await inTx((tx) =>
    endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "unbound_app_pr" }),
  );

  const claimNext = () => inTx((tx) => claimNextEngineeringAgentPublishWork(tx, { leaseMs: 60_000 }));
  const unspent = async () =>
    (await prisma.engineeringAgentCapability.findUniqueOrThrow({ where: { id: issued.capabilityId } })).consumedAt === null;
  assert.equal(await claimNext(), null, "a recorded halt claims nothing");
  assert.ok(await unspent(), "a halted claim spends nothing");
  // The function that spends the capability refuses too, called directly.
  await refusedWith(inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 })), "halted");
  assert.ok(await unspent());
  await refusedWith(startRun(), "halted");

  // Only the acknowledgement clears it -- not a clean run, which cannot start.
  await acknowledge(new Date().toISOString());

  // An open state mismatch halts until it is resolved.
  const { workItemId: mismatchId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, { kind: "state_mismatch", causeKey: `mismatch:${run.runId}`, runId: null, reason: "fixture" }),
  );
  assert.equal(await claimNext(), null, "an open mismatch claims nothing");
  assert.ok(await unspent());
  await refusedWith(startRun(), "halted");
  await prisma.engineeringAgentWorkItem.update({ where: { id: mismatchId }, data: { state: "resolved" } });

  const work = await claimNext();
  assert.ok(work && work.mode === "write" && work.workItemId === workItemId);

  const incidentKey = "amux.incidentMode";
  const previous = await prisma.appSetting.findUnique({ where: { key: incidentKey } });
  const look = () =>
    readEngineeringAgentLastLook(prisma, { workItemId, fencingToken: work.fencingToken, commitDigest: work.commitDigest });
  try {
    await prisma.appSetting.deleteMany({ where: { key: incidentKey } });
    await prisma.appSetting.create({
      data: {
        key: incidentKey,
        value: JSON.stringify({
          version: 1,
          state: "normal",
          transition_id: null,
          changed_at: new Date().toISOString(),
          reason: "engineering agent store fixture",
          ticket: "TEST",
        }),
      },
    });
    assert.deepEqual(await look(), { verdict: "no_objection" });
    // With the acknowledgement before the run's halt, the halt holds again.
    await acknowledge("2000-01-01T00:00:00.000Z");
    assert.deepEqual(await look(), { verdict: "refuse", reason: "halted" });
  } finally {
    await acknowledge(new Date().toISOString());
    await prisma.appSetting.deleteMany({ where: { key: incidentKey } });
    if (previous) await prisma.appSetting.create({ data: { key: incidentKey, value: previous.value } });
  }
  const bound = await settleAndBind(workItemId, work.fencingToken, run.runId);
  await retireBinding(bound.bindingId);
});

test("a claim whose lease passed goes to a lookup, and a lost answer can be found by its request", async () => {
  const run = await startRun();
  const { workItemId } = await inTx((tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "publish",
      causeKey: `publish:${run.runId}:lapse`,
      runId: run.runId,
      patchBody: "patch",
      patchDigest: sha256("patch"),
      baseSha: sha1("base"),
      expectedTreeId: sha1("tree"),
    }),
  );
  const issue = () =>
    inTx((tx) =>
      issueEngineeringAgentCapability(tx, {
        workItemId,
        capability: { baseSha: sha1("base"), patchDigest: sha256("patch"), expectedTreeId: sha1("tree"), commit: commitFields(run.runId, run.cardId) },
      }),
    );
  await issue();
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "t1_queued", halt: "none" }));

  // The publisher claims, and its answer is lost: the request's record names the item.
  const requestKey = `lapse-${randomUUID()}`;
  const lost = await runIdempotentEngineeringAgentRequest({
    route: "publish/claim",
    requestKey,
    body: { requestKey },
    work: (tx) => claimNextEngineeringAgentPublishWork(tx, { leaseMs: 1_000 }),
    resultRef: (work) => work?.workItemId ?? null,
  });
  assert.equal(lost.kind, "done");
  const record = await prisma.engineeringAgentRequest.findUniqueOrThrow({ where: { key: requestKey } });
  assert.equal(record.state, "committed");
  assert.equal(record.resultRef, workItemId);

  // Once the lease passes, the next call looks the work up instead.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const lookup = await inTx((tx) => claimNextEngineeringAgentPublishWork(tx, { leaseMs: 60_000 }));
  assert.ok(lookup && lookup.mode === "lookup" && lookup.workItemId === workItemId);
  // The lookup is told what the consumed capability allowed, to compare a found commit with.
  assert.deepEqual(lookup.consumed, { commitDigest: lookup.consumed?.commitDigest, expectedTreeId: sha1("tree") });
  assert.match(lookup.consumed?.commitDigest ?? "", /^[0-9a-f]{64}$/);
  const requeued = await inTx((tx) =>
    settleEngineeringAgentWorkItem(tx, { workItemId, fencingToken: lookup.fencingToken, outcome: "lookup_no_prior_write" }),
  );
  assert.equal(requeued.state, "queued");
  await issue();
  const again = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));
  const bound = await settleAndBind(workItemId, again.fencingToken, run.runId);
  await retireBinding(bound.bindingId);
});

test("turning the mode on from off passes the armed gate; turning it off and freezing never do", async () => {
  const keys = {
    runner: "engineeringAgent.runnerLastFinishAt",
    publisher: "engineeringAgent.publisherLastFinishAt",
    monitors: "engineeringAgent.monitorsConfirmedAt",
  };
  const setSwitch = (name: "mode" | "freeze", value: string) =>
    inTx((tx) => setEngineeringAgentSwitch(tx, { session: owner, name, value }));
  const record = (key: string, at: Date) =>
    prisma.appSetting.upsert({ where: { key }, create: { key, value: at.toISOString() }, update: { value: at.toISOString() } });
  try {
    await setSwitch("mode", "off");
    await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(keys) } } });
    await refusedWith(setSwitch("mode", "shadow"), "armed_gate_runner_finish_publisher_finish_monitor_confirmation");

    const now = new Date();
    await record(keys.runner, now);
    await record(keys.publisher, now);
    // A monitor confirmation older than a week is no confirmation.
    await record(keys.monitors, new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000));
    await refusedWith(setSwitch("mode", "shadow"), "armed_gate_monitor_confirmation");
    await prisma.appSetting.update({ where: { key: keys.monitors }, data: { value: "not an instant" } });
    await refusedWith(setSwitch("mode", "shadow"), "armed_gate_monitor_confirmation");

    await record(keys.monitors, now);
    await setSwitch("mode", "shadow");
    await setSwitch("mode", "shadow");
    // Stopping is always allowed, whatever the records say.
    await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(keys) } } });
    await setSwitch("freeze", "true");
    await setSwitch("freeze", "false");
    await setSwitch("mode", "off");
    await refusedWith(setSwitch("mode", "shadow"), "armed_gate_runner_finish_publisher_finish_monitor_confirmation");
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(keys) } } });
    await prisma.appSetting.deleteMany({ where: { key: FREEZE_KEY } });
    await prisma.appSetting.upsert({ where: { key: MODE_KEY }, create: { key: MODE_KEY, value: "t1" }, update: { value: "t1" } });
  }
});

test("the owner-queue reading agrees with the run trigger", async () => {
  // Mode t1, and a t1 run already started in this database: the first T1
  // window allows one pull request, and an active run counts as one.
  assert.equal((await readEngineeringAgentOwnerQueues(prisma, "t1")).claimAllowed, true);
  const run = await startRun();
  const full = await readEngineeringAgentOwnerQueues(prisma, "t1");
  assert.equal(full.claimAllowed, false, "the reading says full");
  // The trigger refuses with its own message, not a store code.
  await assert.rejects(startRun(), /owner queue is full/);
  await inTx((tx) => endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "no_change", halt: "none" }));
  assert.equal((await readEngineeringAgentOwnerQueues(prisma, "t1")).claimAllowed, true);
});

test("the armed gate opens on the services' own finishes and a person's monitor record, and a person clears a halt", async () => {
  const keys = [
    "engineeringAgent.runnerLastFinishAt",
    "engineeringAgent.publisherLastFinishAt",
    "engineeringAgent.monitorsConfirmedAt",
  ];
  try {
    await inTx((tx) => setEngineeringAgentSwitch(tx, { session: owner, name: "mode", value: "off" }));
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    await inTx((tx) => recordEngineeringAgentServiceFinish(tx, { service: "runner" }));
    await inTx((tx) => recordEngineeringAgentServiceFinish(tx, { service: "publisher" }));
    await refusedWith(
      inTx((tx) => setEngineeringAgentSwitch(tx, { session: owner, name: "mode", value: "shadow" })),
      "armed_gate_monitor_confirmation",
    );
    await inTx((tx) => recordEngineeringAgentMonitorsConfirmed(tx, { session: owner }));
    await inTx((tx) => setEngineeringAgentSwitch(tx, { session: owner, name: "mode", value: "shadow" }));
    const finish = await prisma.adminAuditLog.findFirst({
      where: { action: "engineering_agent.service_finished", targetId: "engineeringAgent.runnerLastFinishAt" },
    });
    assert.equal(systemActorOf(finish!), "engineering-agent-runner", "a service speaks under its own actor");

    // A recorded halt holds until the acknowledgement, which a person makes.
    await prisma.appSetting.update({ where: { key: MODE_KEY }, data: { value: "t1" } });
    const run = await startRun();
    await inTx((tx) =>
      endEngineeringAgentRun(tx, { runId: run.runId, amuxAttemptId: run.amuxAttemptId, outcome: "no_change", halt: "config_missing" }),
    );
    await refusedWith(startRun(), "halted");
    const acknowledged = await inTx((tx) => acknowledgeEngineeringAgentHalt(tx, { session: owner }));
    const entry = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: acknowledged.auditLogId } });
    assert.equal(entry.actorUserId, owner.user!.id);
    assert.equal((entry.metadata as Record<string, unknown>).unacknowledgedHalt, "config_missing");
    const next = await startRun();
    await inTx((tx) => endEngineeringAgentRun(tx, { runId: next.runId, amuxAttemptId: next.amuxAttemptId, outcome: "no_change", halt: "none" }));
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: { in: keys } } });
    await prisma.appSetting.upsert({ where: { key: MODE_KEY }, create: { key: MODE_KEY, value: "t1" }, update: { value: "t1" } });
  }
});

test("an unbound branch the runner observed halts like a recorded halt, until a person acknowledges it", async () => {
  const ackKey = "engineeringAgent.haltAcknowledgedAt";
  const observedKey = "engineeringAgent.observedHalt";
  const previous = await prisma.appSetting.findUnique({ where: { key: observedKey } });
  await prisma.appSetting.upsert({
    where: { key: ackKey },
    create: { key: ackKey, value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await inTx((tx) => recordEngineeringAgentObservedHalt(tx, { halt: "unbound_app_ref" }));
    const held = await readEngineeringAgentHaltState(prisma);
    assert.equal(held.unacknowledgedHalt, "unbound_app_ref");
    assert.equal(currentEngineeringAgentHalt(held), "unbound_app_ref");
    const entry = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "engineering_agent.halt_observed", targetId: observedKey },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(systemActorOf(entry), "engineering-agent-runner");
    await assert.rejects(
      inTx((tx) => recordEngineeringAgentObservedHalt(tx, { halt: "circuit_open" as never })),
      (error: unknown) => error instanceof EngineeringAgentStoreRefusedError && error.code === "halt_not_observable",
      "a service cannot assert a circuit",
    );
    await inTx((tx) => acknowledgeEngineeringAgentHalt(tx, { session: owner }));
    assert.equal((await readEngineeringAgentHaltState(prisma)).unacknowledgedHalt, null, "acknowledged, it no longer holds");
    const known = await readEngineeringAgentKnownPublishes(prisma);
    assert.ok(Array.isArray(known.bindings) && Array.isArray(known.consumed));
    assert.ok(known.consumed.every((row) => /^[0-9]{1,12}$/.test(row.runId) && /^[0-9a-f]{64}$/.test(row.commitDigest)), "identifiers and digests only");
    assert.ok(known.bindings.every((row) => /^[0-9a-f]{40}$/.test(row.verifiedHeadSha)));
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: observedKey } });
    if (previous) await prisma.appSetting.create({ data: { key: observedKey, value: previous.value } });
  }
});
