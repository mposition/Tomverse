import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { takeAuditChainLock } from "@/lib/adminAudit";
import { createAmuxReviewProposal, getAmuxReviewDetail, resolveAmuxReview } from "@/lib/amux/reviewApproval";
import { acceptAmuxV22AttemptUnknownUsage } from "@/lib/amux/v22AttemptUsageAcceptance";
import { settleAmuxExecution, startAmuxExecution } from "@/lib/amux/execution";
import { heartbeatAmuxWorkerRuntime, registerAmuxWorkerRuntime } from "@/lib/amux/workerRuntime";
import { lockPriorAttempt } from "@/lib/amux/v22TaskRecoveryService";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL, committed fixtures, two writers on one Task at once.
//
// The owner's acceptance of an attempt's unknown usage takes the audit chain
// lock and then the Task row (lib/amux/v22AttemptUsageAcceptance.ts). A review
// resolution used to lock the Task row and take the audit lock only when it
// appended its entry, so the two could each hold what the other waited for and
// PostgreSQL aborted one with 40P01. Every admin writer now takes the audit
// lock before the Task row (lib/adminAudit.ts takeAuditChainLock), and so does
// every system writer: execution settlement locks its resource, runtime and
// attempt rows, then the audit chain, then the Task.

// The admin role is read from the environment at each call.
const ownerUserId = `amux-lock-order-owner-${randomUUID()}`;
const ownerEmail = `${ownerUserId}@example.test`;
process.env.ADMIN_USER_IDS = ownerUserId;
process.env.ADMIN_EMAILS = ownerEmail;
process.env.ADMIN_OWNER_EMAILS = ownerEmail;

const session = {
  user: { id: ownerUserId, email: ownerEmail, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: AMUX lock-order DB tests require DATABASE_URL=TEST_DATABASE_URL");
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
    throw new Error("REFUSE: AMUX lock-order DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

const fixtureTaskIds: string[] = [];
const fixtureWorkers: string[] = [];

after(async () => {
  if (fixtureWorkers.length > 0) {
    await prisma.amuxWorkerRuntime.deleteMany({ where: { workerName: { in: fixtureWorkers } } });
  }
  if (fixtureTaskIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: fixtureTaskIds } },
      data: { archivedAt: new Date() },
    });
  }
  await prisma.$disconnect();
});

const blockedFixture = async () => {
  const task = await prisma.amuxWorkItem.create({
    data: {
      id: `amux-lock-order-${randomUUID()}`,
      title: "AMUX audit lock order fixture",
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

/** Backends of this database waiting on a lock that is not granted. */
const waitingBackends = async () => {
  const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
    SELECT count(*)::bigint AS "waiting" FROM pg_locks
    WHERE NOT granted AND pid <> pg_backend_pid()
  `;
  return Number(rows[0]?.waiting ?? 0);
};

const untilWaiting = async (count: number) => {
  const deadline = Date.now() + 10_000;
  while (await waitingBackends() < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const settle = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);

test("an acceptance and a review resolution on one Task both finish without a deadlock", async () => {
  const fixture = await blockedFixture();
  const request = new Request("http://localhost/api/internal/amux/review", { method: "POST" });
  const detail = await getAmuxReviewDetail(fixture.escalation.id);
  assert.ok(detail.allowed_outcomes.includes("block"));
  const { proposal } = await createAmuxReviewProposal({
    escalationId: fixture.escalation.id,
    outcome: "block",
    expectedSubjectDigest: detail.review_content.digest,
    session,
    request,
  });

  // A third writer holds the audit chain, so both writers queue on it in a
  // known order: the acceptance first, then the review. When it lets go the
  // acceptance runs first and asks for the Task row. Before the fix the
  // review held that row while it waited for the chain: a deadlock.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let holding!: () => void;
  const held = new Promise<void>((resolve) => { holding = resolve; });
  const blocker = prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    holding();
    await released;
  }, { timeout: 30_000 });
  await held;

  const acceptance = settle(acceptAmuxV22AttemptUnknownUsage({
    session, request, taskId: fixture.task.id, attemptId: `attempt-${randomUUID()}`,
  }));
  await untilWaiting(1);
  const review = settle(resolveAmuxReview({
    escalationId: fixture.escalation.id,
    proposalId: proposal.id,
    idempotencyKey: `amux-lock-order-${randomUUID()}`,
    resolution: "Keep blocked while correcting the source.",
    session,
    request,
  }));
  await untilWaiting(2);
  release();
  await blocker;

  const [accepted, resolved] = await Promise.all([acceptance, review]);
  // The fixture is not a v4 Task, so the acceptance is refused -- after it
  // has taken both locks, which is all this test needs of it.
  assert.equal(accepted.ok, false);
  assert.equal((accepted as { error: { code?: string } }).error.code, "task_unavailable",
    String((accepted as { error: unknown }).error));
  assert.ok(resolved.ok, resolved.ok ? "" : String(resolved.error));
  assert.equal(resolved.value.task_status, "blocked");
  const decision = await prisma.amuxReviewDecision.findUniqueOrThrow({
    where: { proposalId: proposal.id },
  });
  assert.equal(decision.outcome, "block");
});

/** Holds the audit chain in a third transaction until released. */
const holdAuditChain = async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let holding!: () => void;
  const held = new Promise<void>((resolve) => { holding = resolve; });
  const blocker = prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    holding();
    await released;
  }, { timeout: 30_000 });
  await held;
  return async () => { release(); await blocker; };
};

test("an execution settlement and an acceptance on one running Task both finish without a deadlock", async () => {
  const taskId = `amux-lock-order-run-${randomUUID()}`;
  const worker = `amux-lock-order-worker-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();
  await prisma.amuxWorkItem.create({ data: {
    id: taskId, title: "AMUX audit lock order execution fixture", status: "todo",
    kind: "code", priority: "p1", pinned: false, drag: 0,
    owner: worker, claimedAt: base, revision: 1,
  } });
  fixtureTaskIds.push(taskId);
  fixtureWorkers.push(worker);
  const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
  await heartbeatAmuxWorkerRuntime({ workerName: worker, instanceId,
    generation: runtime.generation, status: "idle", dispatchReady: true,
    now: new Date(base.getTime() + 100) });
  const started = await startAmuxExecution({ taskId, worker, instanceId,
    generation: runtime.generation, expectedRevision: 1, now: new Date(base.getTime() + 200) });
  if (!started.started) assert.fail(`execution did not start: ${started.reason}`);

  // The acceptance queues on the chain first, the settlement second. Before
  // the settlement took the audit chain ahead of its Task row, it held the
  // Task while it waited, and the acceptance then waited for that Task.
  const releaseChain = await holdAuditChain();
  const request = new Request("http://localhost/api/admin/amux/usage", { method: "POST" });
  const acceptance = settle(acceptAmuxV22AttemptUnknownUsage({
    session, request, taskId, attemptId: started.attemptId,
  }));
  await untilWaiting(1);
  const settlement = settle(settleAmuxExecution({
    attemptId: started.attemptId, worker, instanceId, generation: runtime.generation,
    taskRevision: started.taskRevision, outcome: "succeeded", toStatus: "done",
    actualCostMicrousd: BigInt(0), now: new Date(base.getTime() + 300),
  }));
  await untilWaiting(2);
  await releaseChain();

  const [accepted, settled] = await Promise.all([acceptance, settlement]);
  assert.equal(accepted.ok, false);
  assert.equal((accepted as { error: { code?: string } }).error.code, "task_unavailable",
    String((accepted as { error: unknown }).error));
  assert.ok(settled.ok, settled.ok ? "" : String(settled.error));
  assert.equal(settled.value.settled, true);
  const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(task.status, "done");
});

test("an ended attempt locked before the audit chain does not block a proposal that references it", async () => {
  // A recovery safe stop locks the Task's ended prior attempt and then waits
  // for the audit chain. A review proposal holds the chain and inserts a row
  // that references that attempt; its foreign key check takes FOR KEY SHARE
  // and its guard trigger FOR SHARE. The prior attempt is locked FOR SHARE,
  // which blocks neither; FOR UPDATE would, and the two would deadlock.
  const fixture = await blockedFixture();
  const now = new Date();
  const attempt = await prisma.amuxExecutionAttempt.create({ data: {
    id: `amux-lock-order-attempt-${randomUUID()}`, taskId: fixture.task.id,
    worker: "lock-order-fixture-worker", workerInstanceId: "lock-order-fixture-instance",
    workerGeneration: 1, taskRevision: fixture.task.revision - 1, attemptNumber: 1,
    heartbeatAt: now, startedAt: now, endedAt: now, outcome: "blocked",
    toStatus: "blocked", endedBy: "lock-order-fixture-worker",
  } });
  const request = new Request("http://localhost/api/internal/amux/review", { method: "POST" });
  const detail = await getAmuxReviewDetail(fixture.escalation.id);
  assert.ok(detail.allowed_outcomes.includes("block"));

  const releaseChain = await holdAuditChain();
  const proposal = settle(createAmuxReviewProposal({
    escalationId: fixture.escalation.id, outcome: "block",
    expectedSubjectDigest: detail.review_content.digest, session, request,
  }));
  await untilWaiting(1);
  const safeStopOrder = settle(prisma.$transaction(async (tx) => {
    assert.equal(await lockPriorAttempt(tx, attempt.id), true);
    await takeAuditChainLock(tx);
  }, { timeout: 30_000 }));
  await untilWaiting(2);
  await releaseChain();

  const [proposed, stopped] = await Promise.all([proposal, safeStopOrder]);
  assert.ok(proposed.ok, proposed.ok ? "" : String(proposed.error));
  const row = await prisma.amuxReviewProposal.findUniqueOrThrow({
    where: { id: proposed.value.proposal.id }, select: { attemptId: true } });
  assert.equal(row.attemptId, attempt.id);
  assert.ok(stopped.ok, stopped.ok ? "" : String(stopped.error));
});
