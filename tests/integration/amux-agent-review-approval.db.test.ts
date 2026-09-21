import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  createAmuxReviewProposal,
  getAmuxReviewDetail,
  resolveAmuxReview,
} from "@/lib/amux/reviewApproval";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL tests for the immutable AMUX task-review ledger. The suite
// must run through test:db:integration's migration-built dedicated database;
// db push would not prove that the forward migration installs these triggers.
// No local DATABASE_URL means this suite was not executed, not that it passed.

const actorUserId = `amux-review-approver-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: "reviewer@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

const subjectDigest = "a".repeat(64);
const requestDigest = "b".repeat(64);
const idempotencyKeyHash = "c".repeat(64);
const reviewBaseSha = "c".repeat(40);
const reviewHeadSha = "d".repeat(40);
const reviewDiffDigest = "e".repeat(64);
const fixtureTaskIds: string[] = [];
const fixturePolicyKeys: string[] = [];

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX review DB tests require DATABASE_URL=TEST_DATABASE_URL");
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const schemaName = url.searchParams.get("schema");
  const dedicatedSchema = schemaName === "tomverse_amux_test";
  const canonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!dedicatedSchema && !canonicalCiDatabase) || url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: AMUX review DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

after(async () => {
  // Keep append-only approval evidence, but do not leave a retried todo task
  // dispatchable for a later suite sharing the test database.
  if (fixtureTaskIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: fixtureTaskIds } },
      data: { archivedAt: new Date() },
    });
  }
  if (fixturePolicyKeys.length > 0) {
    await prisma.amuxResourcePolicy.deleteMany({
      where: { scope: "project", key: { in: fixturePolicyKeys } },
    });
  }
  await prisma.$disconnect();
});

const blockedFixture = async () => {
  const task = await prisma.amuxWorkItem.create({
    data: {
      id: `amux-review-${randomUUID()}`,
      title: "AMUX review DB constraint fixture",
      status: "blocked",
      kind: "code",
      priority: "p2",
      revision: 3,
      dueParseState: "valid",
      dueAt: new Date("2026-09-23T00:00:00.000Z"),
      duePrecision: "instant",
      dueSource: "classification",
      dueRaw: "2026-09-23T00:00:00.000Z",
    },
  });
  fixtureTaskIds.push(task.id);
  const escalation = await prisma.amuxHumanEscalation.create({
    data: {
      taskId: task.id,
      specialty: "planning-review",
      reason: "Planning input requires human review.",
      openedBy: "system:amux-task-sync",
      openedTaskRevision: 2,
    },
  });
  return { task, escalation };
};

const issueRetryProposal = async (fixture: Awaited<ReturnType<typeof blockedFixture>>, attemptId?: string) =>
  prisma.amuxReviewProposal.create({
    data: {
      decisionId: randomUUID(),
      escalationId: fixture.escalation.id,
      taskId: fixture.task.id,
      taskRevision: fixture.task.revision,
      outcome: "retry",
      sourceStatus: "blocked",
      targetStatus: "todo",
      subjectDigest,
      attemptId: attemptId ?? null,
      // The migration's BEFORE INSERT trigger must replace both values with
      // one actual DB UTC clock read. A caller cannot mint a future 24h window.
      issuedAt: new Date("2050-01-01T00:00:00.000Z"),
      expiresAt: new Date("2050-01-02T00:00:00.000Z"),
    },
  });

const reviewFixture = async () => {
  const task = await prisma.amuxWorkItem.create({
    data: {
      id: `amux-review-pr-${randomUUID()}`,
      title: "AMUX GitHub PR review source fixture",
      status: "review",
      kind: "code",
      priority: "p2",
      revision: 3,
      requiresHumanReview: true,
      reviewSpecialty: "code-review",
      reviewPrNumber: 1594,
    },
  });
  fixtureTaskIds.push(task.id);
  const now = new Date();
  const attempt = await prisma.amuxExecutionAttempt.create({
    data: {
      id: `amux-review-attempt-${randomUUID()}`,
      taskId: task.id,
      worker: "review-fixture-worker",
      workerInstanceId: "review-fixture-instance",
      workerGeneration: 1,
      taskRevision: task.revision - 1,
      attemptNumber: 1,
      heartbeatAt: now,
      startedAt: now,
      endedAt: now,
      outcome: "succeeded",
      toStatus: "review",
      endedBy: "review-fixture-worker",
    },
  });
  const escalation = await prisma.amuxHumanEscalation.create({
    data: {
      taskId: task.id,
      specialty: "code-review",
      reason: "Completed attempt requires PR review.",
      openedBy: "worker",
      openedTaskRevision: task.revision,
    },
  });
  return { task, attempt, escalation };
};

const issueApproveProposal = async (fixture: Awaited<ReturnType<typeof reviewFixture>>, input: {
  decisionId?: string;
  reviewPrNumber?: number | null;
  reviewBaseSha?: string | null;
  reviewHeadSha?: string | null;
  reviewDiffDigest?: string | null;
} = {}) => prisma.amuxReviewProposal.create({
  data: {
    decisionId: input.decisionId ?? randomUUID(),
    escalationId: fixture.escalation.id,
    taskId: fixture.task.id,
    taskRevision: fixture.task.revision,
    outcome: "approve",
    sourceStatus: "review",
    targetStatus: "done",
    subjectDigest,
    attemptId: fixture.attempt.id,
    reviewPrNumber: input.reviewPrNumber === undefined ? fixture.task.reviewPrNumber : input.reviewPrNumber,
    reviewBaseSha: input.reviewBaseSha === undefined ? reviewBaseSha : input.reviewBaseSha,
    reviewHeadSha: input.reviewHeadSha === undefined ? reviewHeadSha : input.reviewHeadSha,
    reviewDiffDigest: input.reviewDiffDigest === undefined ? reviewDiffDigest : input.reviewDiffDigest,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  },
});

const decideRetry = async (
  fixture: Awaited<ReturnType<typeof blockedFixture>>,
  proposal: Awaited<ReturnType<typeof issueRetryProposal>>,
  options: { auditSubjectDigest?: string; decisionId?: string; taskRevisionIncrement?: number } = {},
) => {
  const decisionId = options.decisionId ?? proposal.decisionId;
  return prisma.$transaction(async (tx) => {
    await tx.amuxWorkItem.update({
      where: { id: fixture.task.id },
      data: {
        status: "todo",
        revision: { increment: options.taskRevisionIncrement ?? 1 },
      },
    });
    await tx.amuxHumanEscalation.update({
      where: { id: fixture.escalation.id },
      data: {
        status: "resolved",
        resolutionOutcome: "retry",
        resolution: "Source data was corrected; retry requested.",
        resolvedById: actorUserId,
        resolvedAt: new Date(),
      },
    });
    const auditLogId = await writeAdminAuditLog({
      session,
      action: "amux.human_escalation.resolved",
      targetType: "AmuxWorkItem",
      targetId: fixture.task.id,
      summary: "Resolved AMUX human escalation.",
      metadata: {
        decision_id: decisionId,
        proposal_id: proposal.id,
        escalation_id: fixture.escalation.id,
        outcome: "retry",
        review_base_sha: null,
        subject_digest: options.auditSubjectDigest ?? subjectDigest,
      },
      tx,
    });
    return tx.amuxReviewDecision.create({
      data: {
        id: decisionId,
        proposalId: proposal.id,
        escalationId: fixture.escalation.id,
        outcome: "retry",
        requestDigest,
        idempotencyKeyHash,
        actorUserId,
        auditLogId,
      },
    });
  });
};

const decideApprove = async (
  fixture: Awaited<ReturnType<typeof reviewFixture>>,
  proposal: Awaited<ReturnType<typeof issueApproveProposal>>,
  taskPrNumber: number,
  options: { decisionId?: string; auditBaseSha?: string | null } = {},
) => {
  const decisionId = options.decisionId ?? proposal.decisionId;
  return prisma.$transaction(async (tx) => {
    await tx.amuxWorkItem.update({
      where: { id: fixture.task.id },
      data: {
        status: "done",
        revision: { increment: 1 },
        reviewPrNumber: taskPrNumber,
      },
    });
    await tx.amuxHumanEscalation.update({
      where: { id: fixture.escalation.id },
      data: {
        status: "resolved",
        resolutionOutcome: "approve",
        resolution: "Reviewed the bound GitHub PR head and diff.",
        resolvedById: actorUserId,
        resolvedAt: new Date(),
      },
    });
    const auditLogId = await writeAdminAuditLog({
      session,
      action: "amux.human_escalation.resolved",
      targetType: "AmuxWorkItem",
      targetId: fixture.task.id,
      summary: "Approved AMUX human review.",
      metadata: {
        decision_id: decisionId,
        proposal_id: proposal.id,
        escalation_id: fixture.escalation.id,
        outcome: "approve",
        review_base_sha: options.auditBaseSha === undefined ? proposal.reviewBaseSha : options.auditBaseSha,
        subject_digest: subjectDigest,
      },
      tx,
    });
    return tx.amuxReviewDecision.create({
      data: {
        id: decisionId,
        proposalId: proposal.id,
        escalationId: fixture.escalation.id,
        outcome: "approve",
        requestDigest,
        idempotencyKeyHash,
        actorUserId,
        auditLogId,
      },
    });
  });
};

test("the DB clock replaces caller timestamps and fixes the proposal lifetime at 24 hours", async () => {
  const fixture = await blockedFixture();
  const before = Date.now();
  const proposal = await issueRetryProposal(fixture);
  const after = Date.now();
  assert.ok(proposal.issuedAt.getTime() >= before - 1_000);
  assert.ok(proposal.issuedAt.getTime() <= after + 1_000);
  assert.equal(proposal.expiresAt.getTime() - proposal.issuedAt.getTime(), 24 * 60 * 60 * 1_000);
  assert.notEqual(proposal.issuedAt.toISOString(), "2050-01-01T00:00:00.000Z");
});

test("proposal issuance refuses stale task revisions and preserves immutable facts", async () => {
  const fixture = await blockedFixture();
  const proposal = await issueRetryProposal(fixture);
  await assert.rejects(
    prisma.amuxReviewProposal.create({
      data: {
        decisionId: randomUUID(),
        escalationId: fixture.escalation.id,
        taskId: fixture.task.id,
        taskRevision: fixture.task.revision + 1,
        outcome: "retry",
        sourceStatus: "blocked",
        targetStatus: "todo",
        subjectDigest,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      },
    }),
    /does not match the current task and escalation/,
  );
  await assert.rejects(
    prisma.amuxReviewProposal.update({
      where: { id: proposal.id },
      data: { subjectDigest: "d".repeat(64) },
    }),
    /append-only/,
  );
  await assert.rejects(
    prisma.amuxReviewProposal.delete({ where: { id: proposal.id } }),
    /append-only/,
  );
});

test("planning-review retry needs a recorded earlier revision, never an invented legacy backfill", async () => {
  const fixture = await blockedFixture();
  await prisma.amuxHumanEscalation.update({
    where: { id: fixture.escalation.id },
    data: { openedTaskRevision: null },
  });
  await assert.rejects(
    issueRetryProposal(fixture),
    /planning-review retry requires a newer task revision/,
  );
  await prisma.amuxHumanEscalation.update({
    where: { id: fixture.escalation.id },
    data: { openedTaskRevision: fixture.task.revision },
  });
  await assert.rejects(
    issueRetryProposal(fixture),
    /planning-review retry requires a newer task revision/,
  );
  assert.equal(await prisma.amuxReviewProposal.count({ where: { escalationId: fixture.escalation.id } }), 0);
});

test("planning retry requires a valid due and cannot reset five historical attempts", async () => {
  const fixture = await blockedFixture();
  await prisma.amuxWorkItem.update({
    where: { id: fixture.task.id }, data: {
      dueParseState: "invalid",
      dueAt: null,
      duePrecision: null,
      dueSource: "classification",
      dueRaw: "not-a-date",
    },
  });
  await assert.rejects(issueRetryProposal(fixture), /planning-review retry requires a newer task revision/);
  await prisma.amuxWorkItem.update({
    where: { id: fixture.task.id }, data: {
      dueParseState: "valid",
      dueAt: new Date("2026-09-23T00:00:00.000Z"),
      duePrecision: "instant",
      dueSource: "classification",
      dueRaw: "2026-09-23T00:00:00.000Z",
    },
  });
  const now = new Date();
  let latestAttemptId = "";
  for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber++) {
    latestAttemptId = `amux-review-budget-${randomUUID()}`;
    await prisma.amuxExecutionAttempt.create({
      data: {
        id: latestAttemptId,
        taskId: fixture.task.id,
        worker: "budget-fixture-worker",
        workerInstanceId: "budget-fixture-instance",
        workerGeneration: 1,
        taskRevision: 2,
        attemptNumber,
        heartbeatAt: now,
        startedAt: new Date(now.getTime() + attemptNumber),
        endedAt: new Date(now.getTime() + attemptNumber),
        outcome: "blocked",
        toStatus: "blocked",
        endedBy: "budget-fixture-worker",
      },
    });
  }
  await assert.rejects(
    issueRetryProposal(fixture, latestAttemptId),
    /review retry attempt budget exhausted/,
  );
});

test("new resolved escalations cannot omit a machine-readable outcome", async () => {
  const fixture = await blockedFixture();
  await assert.rejects(prisma.amuxHumanEscalation.update({
    where: { id: fixture.escalation.id },
    data: {
      status: "resolved",
      resolvedById: actorUserId,
      resolvedAt: new Date(),
      resolution: "No outcome was supplied.",
    },
  }));
  assert.equal((await prisma.amuxHumanEscalation.findUniqueOrThrow({
    where: { id: fixture.escalation.id },
  })).status, "open");
});

test("a recoverable block opens a successor for another reason and bounded retry", async () => {
  const fixture = await blockedFixture();
  const request = new Request("http://localhost/api/internal/amux/review", { method: "POST" });
  const firstDetail = await getAmuxReviewDetail(fixture.escalation.id);
  assert.ok(firstDetail.allowed_outcomes.includes("block"));
  const firstProposal = await createAmuxReviewProposal({
    escalationId: fixture.escalation.id,
    outcome: "block",
    expectedSubjectDigest: firstDetail.review_content.digest,
    session,
    request,
  });
  const firstDecision = await resolveAmuxReview({
    escalationId: fixture.escalation.id,
    proposalId: firstProposal.proposal.id,
    idempotencyKey: `amux-review-block-${randomUUID()}`,
    resolution: "Keep blocked while correcting the source.",
    session,
    request,
  });
  assert.equal(firstDecision.task_status, "blocked");
  const successor = await prisma.amuxHumanEscalation.findFirstOrThrow({
    where: { taskId: fixture.task.id, status: "open" },
  });
  assert.notEqual(successor.id, fixture.escalation.id);
  assert.equal(successor.openedTaskRevision, fixture.task.revision + 1);

  await prisma.amuxWorkItem.update({
    where: { id: fixture.task.id },
    data: { dueParseState: "valid", revision: { increment: 1 } },
  });
  const retryDetail = await getAmuxReviewDetail(successor.id);
  assert.equal(retryDetail.review_context.previous_block_reason, "Keep blocked while correcting the source.");
  assert.ok(retryDetail.allowed_outcomes.includes("retry"));
  const retryProposal = await createAmuxReviewProposal({
    escalationId: successor.id,
    outcome: "retry",
    expectedSubjectDigest: retryDetail.review_content.digest,
    session,
    request,
  });
  const retryDecision = await resolveAmuxReview({
    escalationId: successor.id,
    proposalId: retryProposal.proposal.id,
    idempotencyKey: `amux-review-retry-${randomUUID()}`,
    resolution: "Corrected canonical deadline and requeued.",
    session,
    request,
  });
  assert.equal(retryDecision.task_status, "todo");
  assert.equal(await prisma.amuxHumanEscalation.count({
    where: { taskId: fixture.task.id, status: { in: ["open", "acknowledged"] } },
  }), 0);
});

test("retry refuses a currently exhausted project cost cap before requeue", async () => {
  const fixture = await blockedFixture();
  const projectKey = `amux-review-cost-${randomUUID()}`;
  fixturePolicyKeys.push(projectKey);
  await prisma.amuxResourcePolicy.create({
    data: {
      scope: "project",
      key: projectKey,
      displayName: projectKey,
      costBudgetMicrousd: BigInt(100),
      budgetWindowStartsAt: new Date(Date.now() - 60_000),
      budgetWindowEndsAt: new Date(Date.now() + 60_000),
    },
  });
  await prisma.amuxWorkItem.update({
    where: { id: fixture.task.id },
    data: { projectKey, estimatedCostMicrousd: BigInt(101) },
  });
  const request = new Request("http://localhost/api/internal/amux/review", { method: "POST" });
  const detail = await getAmuxReviewDetail(fixture.escalation.id);
  const proposal = await createAmuxReviewProposal({
    escalationId: fixture.escalation.id,
    outcome: "retry",
    expectedSubjectDigest: detail.review_content.digest,
    session,
    request,
  });
  await assert.rejects(resolveAmuxReview({
    escalationId: fixture.escalation.id,
    proposalId: proposal.proposal.id,
    idempotencyKey: `amux-review-cost-${randomUUID()}`,
    resolution: "Retry after cost cap review.",
    session,
    request,
  }), /AMUX_REVIEW_COST_GUARD_BLOCKED/);
  assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.task.id } })).status, "blocked");
});

test("approve proposals bind a complete GitHub PR head and diff digest to the task PR", async () => {
  const fixture = await reviewFixture();
  const proposal = await issueApproveProposal(fixture);
  assert.equal(typeof proposal.decisionId, "string");
  assert.equal(proposal.reviewPrNumber, fixture.task.reviewPrNumber);
  assert.equal(proposal.reviewBaseSha, reviewBaseSha);
  assert.equal(proposal.reviewHeadSha, reviewHeadSha);
  assert.equal(proposal.reviewDiffDigest, reviewDiffDigest);

  await assert.rejects(issueApproveProposal(fixture, { reviewPrNumber: 1595 }), /PR does not match the task source/);
  await assert.rejects(issueApproveProposal(fixture, { reviewPrNumber: null }));
  await assert.rejects(issueApproveProposal(fixture, { reviewBaseSha: null }));
  await assert.rejects(issueApproveProposal(fixture, { reviewHeadSha: null }));
  await assert.rejects(issueApproveProposal(fixture, { reviewDiffDigest: null }));
  await assert.rejects(issueApproveProposal(fixture, { reviewHeadSha: "F".repeat(40) }));
  await assert.rejects(issueApproveProposal(fixture, { reviewBaseSha: "F".repeat(40) }));
  await assert.rejects(issueApproveProposal(fixture, { reviewDiffDigest: "F".repeat(64) }));
  assert.equal(await prisma.amuxReviewProposal.count({ where: { escalationId: fixture.escalation.id } }), 1);
});

test("review PR attached after settlement remains approvable across a metadata-only revision", async () => {
  const fixture = await reviewFixture();
  await prisma.amuxWorkItem.update({
    where: { id: fixture.task.id },
    data: { reviewPrNumber: null },
  });
  const withPr = await prisma.amuxWorkItem.update({
    where: { id: fixture.task.id },
    data: { reviewPrNumber: 1594, revision: { increment: 1 } },
  });
  const proposal = await issueApproveProposal({ ...fixture, task: withPr });
  assert.equal(proposal.taskRevision, fixture.task.revision + 1);
  assert.equal(proposal.attemptId, fixture.attempt.id);
});

test("a preallocated decision UUID cannot be reused by a second proposal", async () => {
  const fixture = await reviewFixture();
  const decisionId = randomUUID();
  const proposal = await issueApproveProposal(fixture, { decisionId });
  assert.equal(proposal.decisionId, decisionId);
  await assert.rejects(issueApproveProposal(fixture, { decisionId }));
  assert.equal(await prisma.amuxReviewProposal.count({ where: { decisionId } }), 1);
});

test("approval decision accepts the bound PR and refuses a changed task PR atomically", async () => {
  const good = await reviewFixture();
  const goodProposal = await issueApproveProposal(good);
  const decision = await decideApprove(good, goodProposal, 1594);
  assert.equal(decision.outcome, "approve");
  assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: good.task.id } })).status, "done");

  const changed = await reviewFixture();
  const changedProposal = await issueApproveProposal(changed);
  await assert.rejects(
    decideApprove(changed, changedProposal, 1595),
    /does not match the task CAS transition/,
  );
  const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: changed.task.id } });
  assert.equal(task.status, "review");
  assert.equal(task.reviewPrNumber, 1594);
  assert.equal(await prisma.amuxReviewDecision.count({ where: { proposalId: changedProposal.id } }), 0);
});

test("decision UUID and audited base SHA must match the immutable proposal", async () => {
  const wrongId = await reviewFixture();
  const wrongIdProposal = await issueApproveProposal(wrongId);
  await assert.rejects(
    decideApprove(wrongId, wrongIdProposal, 1594, { decisionId: randomUUID() }),
    /mismatched or expired proposal/,
  );
  assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: wrongId.task.id } })).status, "review");
  assert.equal(await prisma.amuxReviewDecision.count({ where: { proposalId: wrongIdProposal.id } }), 0);

  const wrongBase = await reviewFixture();
  const wrongBaseProposal = await issueApproveProposal(wrongBase);
  await assert.rejects(
    decideApprove(wrongBase, wrongBaseProposal, 1594, { auditBaseSha: "f".repeat(40) }),
    /does not match its admin audit entry/,
  );
  assert.equal((await prisma.amuxHumanEscalation.findUniqueOrThrow({ where: { id: wrongBase.escalation.id } })).status, "open");
  assert.equal(await prisma.amuxReviewDecision.count({ where: { proposalId: wrongBaseProposal.id } }), 0);
});

test("block and retry proposals cannot carry PR source fields", async () => {
  const fixture = await blockedFixture();
  await assert.rejects(prisma.amuxReviewProposal.create({
    data: {
      decisionId: randomUUID(),
      escalationId: fixture.escalation.id,
      taskId: fixture.task.id,
      taskRevision: fixture.task.revision,
      outcome: "retry",
      sourceStatus: "blocked",
      targetStatus: "todo",
      subjectDigest,
      reviewPrNumber: 1594,
      reviewBaseSha,
      reviewHeadSha,
      reviewDiffDigest,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    },
  }));
  await assert.rejects(prisma.amuxWorkItem.create({
    data: {
      title: "Invalid review PR without human review",
      status: "todo",
      reviewPrNumber: 1594,
      requiresHumanReview: false,
    },
  }));
});

test("one transaction resolves the escalation, advances task CAS and appends one audited decision", async () => {
  const fixture = await blockedFixture();
  const proposal = await issueRetryProposal(fixture);
  const decision = await decideRetry(fixture, proposal);

  const [task, escalation, audit] = await Promise.all([
    prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.task.id } }),
    prisma.amuxHumanEscalation.findUniqueOrThrow({ where: { id: fixture.escalation.id } }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: decision.auditLogId } }),
  ]);
  assert.equal(task.status, "todo");
  assert.equal(task.revision, fixture.task.revision + 1);
  assert.equal(escalation.status, "resolved");
  assert.equal(escalation.resolutionOutcome, "retry");
  assert.equal(audit.actorUserId, actorUserId);
  assert.equal((audit.metadata as { decision_id: string }).decision_id, decision.id);

  await assert.rejects(
    prisma.amuxReviewDecision.update({
      where: { id: decision.id },
      data: { requestDigest: "d".repeat(64) },
    }),
    /append-only/,
  );
  await assert.rejects(
    prisma.amuxReviewDecision.create({
      data: {
        id: randomUUID(),
        proposalId: proposal.id,
        escalationId: fixture.escalation.id,
        outcome: "retry",
        requestDigest,
        idempotencyKeyHash: "e".repeat(64),
        actorUserId,
        auditLogId: decision.auditLogId,
      },
    }),
  );
  assert.equal(await prisma.amuxReviewDecision.count({ where: { escalationId: fixture.escalation.id } }), 1);
});

test("mismatched audit digest rolls back task, escalation and audit together", async () => {
  const fixture = await blockedFixture();
  const proposal = await issueRetryProposal(fixture);
  await assert.rejects(
    decideRetry(fixture, proposal, { auditSubjectDigest: "f".repeat(64) }),
    /does not match its admin audit entry/,
  );
  const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.task.id } });
  const escalation = await prisma.amuxHumanEscalation.findUniqueOrThrow({ where: { id: fixture.escalation.id } });
  assert.equal(task.status, "blocked");
  assert.equal(task.revision, fixture.task.revision);
  assert.equal(escalation.status, "open");
  assert.equal(await prisma.amuxReviewDecision.count({ where: { proposalId: proposal.id } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "amux.human_escalation.resolved", targetId: fixture.task.id },
  }), 0);
});

test("the decision trigger refuses a task transition that is not revision +1", async () => {
  const fixture = await blockedFixture();
  const proposal = await issueRetryProposal(fixture);
  await assert.rejects(
    decideRetry(fixture, proposal, { taskRevisionIncrement: 2 }),
    /does not match the task CAS transition/,
  );
  assert.equal(await prisma.amuxReviewDecision.count({ where: { proposalId: proposal.id } }), 0);
});
