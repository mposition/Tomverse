import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import {
  AMUX_ATTACHMENT_MAX_PRISMA_CALLS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  acknowledgeAmuxWorkDelivery,
  pullAmuxWorkDelivery,
} from "@/lib/amux/delivery";
import {
  amuxAgentUsageWindow,
  heartbeatAmuxExecution,
  reclaimExpiredAmuxExecutions,
  settleAmuxExecution,
  startAmuxExecution,
} from "@/lib/amux/execution";
import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import { registerAmuxAgentIntakeCard } from "@/lib/amux/agentIntake";
import { recordAmuxReviewPullRequest } from "@/lib/amux/reviewPullRequest";
import {
  heartbeatAmuxWorkerRuntime,
  registerAmuxWorkerRuntime,
} from "@/lib/amux/workerRuntime";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  ENGINEERING_AGENT_AMUX_WORKER,
  engineeringAgentAmuxAdapterPermittedNow,
  recordEngineeringAgentPublisherResult,
  registerEngineeringAgentWorker,
  engineeringPublishResultAttachment,
  engineeringRunEndAttachment,
  engineeringRunHeartbeatAttachment,
  engineeringRunStartAttachment,
} from "@/lib/engineeringAgentAmuxAdapter";
import type { Session } from "next-auth";

import {
  EngineeringAgentStoreRefusedError,
  claimEngineeringAgentWorkItem,
  currentEngineeringAgentHalt,
  endEngineeringAgentRun,
  lockEngineeringAgentMismatchAmuxRows,
  readEngineeringAgentHaltState,
  resolveEngineeringAgentStateMismatch,
  engineeringAgentTransactionInAmux,
  issueEngineeringAgentCapability,
  moveEngineeringAgentBinding,
  openEngineeringAgentRunMismatches,
  openEngineeringAgentWorkItem,
  recordEngineeringAgentRegistration,
  recordEngineeringAgentRegistrationReadBack,
  runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { runAttachedIdempotentEngineeringAgentRequest } from "@/lib/engineeringAgentRouteAuth";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for the engineering adapter
// (docs/policy/engineering-agent.md §8, §11, §14; development-agent-
// orchestration.md, Authority, version 12): the engineering run is written in
// the AMUX writer's own transaction, after every AMUX row lock, so the two are
// one fact or neither happened; and the adapter's settlement runs against
// AMUX's delivery acknowledgement and expired-execution recovery without a
// deadlock. The AMUX writers are called directly with the adapter's
// attachments. The public adapter functions also need the execution API gate
// (version 25 turned the code latch on); only the tests of the whole gate
// open it, and each closes it again.
// A missing TEST_DATABASE_URL means this file was not executed, not that it
// passed.

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error(
      "REFUSE: engineering agent DB tests require DATABASE_URL=TEST_DATABASE_URL",
    );
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (
    !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(databaseName) ||
    url.hostname.startsWith("pooled.")
  ) {
    throw new Error(
      "REFUSE: engineering agent DB tests require a direct dedicated test database",
    );
  }
};

requireDedicatedDatabase();

const MODE_KEY = "feature.engineeringAgentMode";
const FREEZE_KEY = "feature.engineeringAgentFreeze";
const fixtureTaskIds: string[] = [];
const fixtureWorkers: string[] = [];
/** Publish items whose result was recorded while the adapter was closed. */
const closedAdapterFixtures: Array<{ runId: string; workItemId: string }> = [];

const setMode = (value: string) =>
  prisma.appSetting.upsert({
    where: { key: MODE_KEY },
    create: { key: MODE_KEY, value },
    update: { value },
  });

// A missing AMUX incident reading freezes admission, so the file writes a
// normal one and puts back whatever was there.
const INCIDENT_KEY = "amux.incidentMode";
let previousIncident: { value: string } | null = null;

// Shadow is enough for a run, and it holds no pull request window open for
// the engineering files that run after this one.
before(async () => {
  await setMode("shadow");
  await prisma.appSetting.deleteMany({ where: { key: FREEZE_KEY } });
  previousIncident = await prisma.appSetting.findUnique({
    where: { key: INCIDENT_KEY },
    select: { value: true },
  });
  const normal = JSON.stringify({
    version: 1,
    state: "normal",
    transition_id: null,
    changed_at: new Date().toISOString(),
    reason: "engineering adapter fixture",
    ticket: "TEST",
  });
  await prisma.appSetting.upsert({
    where: { key: INCIDENT_KEY },
    create: { key: INCIDENT_KEY, value: normal },
    update: { value: normal },
  });
});

after(async () => {
  // AMUX recovery in these tests ends every expired attempt, so this file's
  // own runs can be left active under ended attempts. Only this file's runs
  // are touched, and only through the product's own action: a person closes
  // each mismatch, which the resolver refuses for a run that was ever allowed
  // to write -- then this hook throws and the suite fails, as it should.
  const owner = {
    user: { id: `eng-adapter-owner-${randomUUID()}`, email: "owner@example.test" },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as Session;
  // A closed-adapter result's mismatch names no run, so the sweep below would
  // miss it; it is closed here, whatever stopped its test.
  for (const fixture of closedAdapterFixtures) await closeClosedAdapterFixture(fixture);
  // Only this file's runs are opened as mismatches: a sweep would open one
  // for any other suite's orphaned run too, and leave it open.
  const orphaned = await prisma.engineeringAgentRun.findMany({
    where: { id: { in: fixtureRunIds }, status: "active", attempt: { endedAt: { not: null } } },
    select: { id: true },
  });
  for (const run of orphaned) {
    const causeKey = `run_attempt:${run.id}`;
    if ((await prisma.engineeringAgentWorkItem.count({ where: { causeKey } })) > 0) continue;
    await runEngineeringAgentTransaction(prisma, (tx) =>
      openEngineeringAgentWorkItem(tx, { kind: "state_mismatch", causeKey, runId: run.id, reason: "attempt_ended_run_active" }),
    );
  }
  const open = await prisma.engineeringAgentWorkItem.findMany({
    where: { kind: "state_mismatch", state: "open", runId: { in: fixtureRunIds } },
    select: { id: true },
  });
  for (const item of open) {
    await runEngineeringAgentTransaction(
      prisma,
      (tx) =>
        resolveEngineeringAgentStateMismatch(tx, {
          session: owner,
          workItemId: item.id,
          action: "close_domain_after_verified_no_write",
        }),
      { beforeAuditLock: (tx) => lockEngineeringAgentMismatchAmuxRows(tx, item.id) },
    );
  }
  // The halts this file's runs recorded are acknowledged as of the last of
  // them, and no later: a halt anything else records afterwards still holds.
  const lastHalted = await prisma.engineeringAgentRun.findFirst({
    where: { id: { in: fixtureRunIds }, halt: { not: "none" }, endedAt: { not: null } },
    orderBy: { endedAt: "desc" },
    select: { endedAt: true },
  });
  if (lastHalted?.endedAt) {
    const acknowledgedAt = lastHalted.endedAt.toISOString();
    await prisma.appSetting.upsert({
      where: { key: "engineeringAgent.haltAcknowledgedAt" },
      create: { key: "engineeringAgent.haltAcknowledgedAt", value: acknowledgedAt },
      update: { value: acknowledgedAt },
    });
  }
  await prisma.appSetting.deleteMany({ where: { key: INCIDENT_KEY } });
  if (previousIncident) {
    await prisma.appSetting.create({
      data: { key: INCIDENT_KEY, value: previousIncident.value },
    });
  }
  await prisma.appSetting.deleteMany({ where: { key: MODE_KEY } });
  if (fixtureTaskIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: fixtureTaskIds } },
      data: { archivedAt: new Date() },
    });
  }
  if (fixtureWorkers.length > 0) {
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: { in: fixtureWorkers } },
    });
  }
  await prisma.$disconnect();
});

const sha1 = (seed: string) => createHash("sha1").update(seed).digest("hex");
let runCounter = 700_000_000 + (Math.floor(Date.now() / 1000) % 100_000_000);
const fixtureRunIds: string[] = [];
const nextRunId = () => {
  const runId = String((runCounter += 1));
  fixtureRunIds.push(runId);
  return runId;
};

/** A worker that is registered, idle and ready, and a todo card it owns. */
const readyWorkerWithCard = async (options: { requiresHumanReview?: boolean } = {}) => {
  const worker = `eng-adapter-${randomUUID().slice(0, 12)}`;
  const instanceId = randomUUID();
  fixtureWorkers.push(worker);
  const taskId = `eng-adapter-card-${randomUUID()}`;
  await prisma.amuxWorkItem.create({
    data: {
      id: taskId,
      title: "Engineering adapter fixture",
      status: "todo",
      kind: "code",
      priority: "p2",
      pinned: false,
      drag: 0,
      owner: worker,
      claimedAt: new Date(),
      revision: 1,
      requiresHumanReview: options.requiresHumanReview ?? false,
      reviewSpecialty: options.requiresHumanReview ? "code-review" : null,
    },
  });
  fixtureTaskIds.push(taskId);
  const runtime = await registerAmuxWorkerRuntime(worker, instanceId);
  const ready = await heartbeatAmuxWorkerRuntime({
    workerName: worker,
    instanceId,
    generation: runtime.generation,
    status: "idle",
    dispatchReady: true,
  });
  assert.equal(ready.accepted, true);
  return { worker, instanceId, generation: runtime.generation, taskId };
};

type Fixture = Awaited<ReturnType<typeof readyWorkerWithCard>>;

// Inside the adapter routes' own budget, as run/start calls it: a writer's
// transaction budget grows with the calls its attachment declares.
const startWithRun = async (fixture: Fixture, runId: string) => {
  const started = await withAmuxRouteBudget(
    () =>
      startAmuxExecution(
        {
          taskId: fixture.taskId,
          worker: fixture.worker,
          instanceId: fixture.instanceId,
          generation: fixture.generation,
          expectedRevision: 1,
        },
        engineeringRunStartAttachment({ runId, baseSha: sha1(runId) }),
      ),
    ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  );
  if (!started.started)
    throw new Error(`execution did not start: ${started.reason}`);
  return started;
};

const settleWithRun = (
  fixture: Fixture,
  started: { attemptId: string; taskRevision: number },
  runId: string,
) =>
  withAmuxRouteBudget(
    () =>
      settleAmuxExecution(
        {
          attemptId: started.attemptId,
          worker: fixture.worker,
          instanceId: fixture.instanceId,
          generation: fixture.generation,
          taskRevision: started.taskRevision,
          outcome: "succeeded",
          toStatus: "review",
          actualCostMicrousd: null,
        },
        engineeringRunEndAttachment({
          runId,
          outcome: "t2_draft",
          halt: "none",
        }),
      ),
    ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  );

test("an attachment declares a bounded call budget", async () => {
  await assert.rejects(() =>
    startAmuxExecution(
      {
        taskId: "x",
        worker: "x",
        instanceId: randomUUID(),
        generation: 1,
        expectedRevision: 0,
      },
      {
        prismaCalls: AMUX_ATTACHMENT_MAX_PRISMA_CALLS + 1,
        work: async () => undefined,
      },
    ),
  );
});

test("the run is written in the AMUX start's transaction, and a refused run rolls the start back", async () => {
  const fixture = await readyWorkerWithCard();

  // The operating mode refuses a run: the AMUX start goes with it.
  await setMode("off");
  const refusedRunId = nextRunId();
  await assert.rejects(
    startWithRun(fixture, refusedRunId),
    (error: unknown) =>
      error instanceof EngineeringAgentStoreRefusedError &&
      error.code === "switch_refused_claimAllowed",
  );
  const untouched = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: fixture.taskId },
  });
  assert.equal(untouched.status, "todo");
  assert.equal(untouched.revision, 1);
  assert.equal(
    await prisma.amuxExecutionAttempt.count({
      where: { taskId: fixture.taskId },
    }),
    0,
  );
  assert.equal(
    await prisma.amuxWorkDelivery.count({ where: { taskId: fixture.taskId } }),
    0,
  );
  assert.equal(
    await prisma.engineeringAgentRun.count({ where: { id: refusedRunId } }),
    0,
  );
  const idle = await prisma.amuxWorkerRuntime.findUniqueOrThrow({
    where: { workerName: fixture.worker },
  });
  assert.equal(
    idle.status,
    "idle",
    "the runtime stays idle when the start rolls back",
  );

  await setMode("shadow");
  const runId = nextRunId();
  const started = await startWithRun(fixture, runId);
  const run = await prisma.engineeringAgentRun.findUniqueOrThrow({
    where: { id: runId },
  });
  assert.equal(run.amuxAttemptId, started.attemptId);
  assert.equal(run.cardId, fixture.taskId);
  assert.equal(
    run.cardKind,
    "code",
    "the kind comes from the AMUX row, not the request",
  );
  assert.equal(run.status, "active");
  assert.equal(run.modeAtStart, "shadow");
  const doing = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: fixture.taskId },
  });
  assert.equal(doing.status, "doing");
  const audits = await prisma.adminAuditLog.findMany({
    where: { OR: [{ targetId: fixture.taskId }, { targetId: runId }] },
    select: { action: true },
  });
  const actions = audits.map((row) => row.action);
  assert.ok(actions.includes("amux.execution.started"));
  assert.ok(
    actions.some((action) => action.startsWith("engineering_agent.run")),
    actions.join(","),
  );

  const settled = await settleWithRun(fixture, started, runId);
  assert.deepEqual(settled, {
    settled: true,
    taskRevision: started.taskRevision + 1,
  });
});

test("a run's lease moves only with its own attempt's, and a run ends only with its own settlement", async () => {
  const first = await readyWorkerWithCard();
  const second = await readyWorkerWithCard();
  const firstRunId = nextRunId();
  const secondRunId = nextRunId();
  const firstStarted = await startWithRun(first, firstRunId);
  const secondStarted = await startWithRun(second, secondRunId);

  const heartbeat = (
    fixture: Fixture,
    started: typeof firstStarted,
    runId: string,
  ) =>
    heartbeatAmuxExecution(
      {
        attemptId: started.attemptId,
        worker: fixture.worker,
        instanceId: fixture.instanceId,
        generation: fixture.generation,
        taskRevision: started.taskRevision,
      },
      engineeringRunHeartbeatAttachment({ runId }),
    );

  // Renewing the first attempt with the second run's id renews neither.
  const attemptBefore = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
    where: { id: firstStarted.attemptId },
  });
  await assert.rejects(
    heartbeat(first, firstStarted, secondRunId),
    EngineeringAgentStoreRefusedError,
  );
  const attemptAfterRefusal =
    await prisma.amuxExecutionAttempt.findUniqueOrThrow({
      where: { id: firstStarted.attemptId },
    });
  assert.deepEqual(
    attemptAfterRefusal.leaseExpiresAt,
    attemptBefore.leaseExpiresAt,
  );

  const runBefore = await prisma.engineeringAgentRun.findUniqueOrThrow({
    where: { id: firstRunId },
  });
  assert.equal(await heartbeat(first, firstStarted, firstRunId), true);
  const runAfter = await prisma.engineeringAgentRun.findUniqueOrThrow({
    where: { id: firstRunId },
  });
  const attemptAfter = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
    where: { id: firstStarted.attemptId },
  });
  assert.ok(
    runAfter.leaseExpiresAt > runBefore.leaseExpiresAt,
    "the run's lease moved",
  );
  assert.ok(
    attemptAfter.leaseExpiresAt! > attemptBefore.leaseExpiresAt!,
    "the attempt's lease moved",
  );

  // Settling the first attempt as the second run leaves both where they were.
  await assert.rejects(
    settleWithRun(first, firstStarted, secondRunId),
    EngineeringAgentStoreRefusedError,
  );
  const stillDoing = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: first.taskId },
  });
  assert.equal(stillDoing.status, "doing");
  assert.equal(
    (
      await prisma.engineeringAgentRun.findUniqueOrThrow({
        where: { id: secondRunId },
      })
    ).status,
    "active",
  );

  assert.equal(
    (await settleWithRun(first, firstStarted, firstRunId)).settled,
    true,
  );
  assert.equal(
    (await settleWithRun(second, secondStarted, secondRunId)).settled,
    true,
  );
  const firstRun = await prisma.engineeringAgentRun.findUniqueOrThrow({
    where: { id: firstRunId },
  });
  assert.equal(firstRun.status, "finished");
  assert.equal(firstRun.outcome, "t2_draft");
  const reviewed = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: first.taskId },
  });
  assert.equal(reviewed.status, "review");
  const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
    where: { id: firstStarted.attemptId },
  });
  assert.equal(
    attempt.settledCostMicrousd,
    null,
    "no agent cost enters the attempt's settlement",
  );
  assert.equal(
    await prisma.amuxCostLedgerEntry.count({
      where: { attemptId: firstStarted.attemptId },
    }),
    0,
  );
});

test("the adapter's settlement runs against delivery acknowledgement and expired recovery without a deadlock", async () => {
  const rounds = 4;
  for (let round = 0; round < rounds; round += 1) {
    const fixture = await readyWorkerWithCard();
    const runId = nextRunId();
    const started = await startWithRun(fixture, runId);
    const pulled = await pullAmuxWorkDelivery({
      worker: fixture.worker,
      instanceId: fixture.instanceId,
      generation: fixture.generation,
    });
    assert.equal(pulled.available, true);
    const receiptId = pulled.available ? pulled.delivery.receiptId : "";

    // Recovery reads the attempt as expired; the settlement reads it as live.
    const results = await Promise.allSettled([
      settleWithRun(fixture, started, runId),
      acknowledgeAmuxWorkDelivery({
        attemptId: started.attemptId,
        receiptId,
        worker: fixture.worker,
        instanceId: fixture.instanceId,
        generation: fixture.generation,
        taskRevision: started.taskRevision,
      }),
      reclaimExpiredAmuxExecutions({
        now: new Date(Date.now() + 10 * 60_000),
        limit: 200,
      }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        const code = (result.reason as { code?: unknown })?.code;
        const message = String(
          (result.reason as Error)?.message ?? result.reason,
        );
        assert.doesNotMatch(message, /deadlock/i, `round ${round}: ${message}`);
        assert.notEqual(code, "40P01", `round ${round}: deadlock`);
      }
    }

    // Whatever won, the run and the attempt tell the same story, or the run is
    // still active for the person who reconciles a mismatch (§11).
    const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
    });
    const run = await prisma.engineeringAgentRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const settle = results[0];
    const settledByAdapter =
      settle.status === "fulfilled" && settle.value.settled === true;
    if (settledByAdapter) {
      assert.equal(attempt.endedBy, fixture.worker);
      assert.equal(run.status, "finished");
    } else {
      assert.equal(
        run.status,
        "active",
        `round ${round}: a fenced-out settlement ends no run`,
      );
      // The run is not ended to match AMUX: a mismatch goes to a person, once.
      assert.ok(attempt.endedAt, `round ${round}: recovery ended the attempt`);
      const opened = await runEngineeringAgentTransaction(prisma, (tx) =>
        openEngineeringAgentRunMismatches(tx),
      );
      assert.ok(opened >= 1);
      assert.equal(
        await runEngineeringAgentTransaction(prisma, (tx) =>
          openEngineeringAgentRunMismatches(tx),
        ),
        0,
        "a run is reported once",
      );
      const mismatch = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({
        where: { causeKey: `run_attempt:${runId}` },
      });
      assert.equal(mismatch.kind, "state_mismatch");
      assert.equal(mismatch.state, "open");
      // Here the fixture plays the person who resolves it.
      await runEngineeringAgentTransaction(prisma, (tx) =>
        endEngineeringAgentRun(tx, {
          runId,
          amuxAttemptId: started.attemptId,
          outcome: "abandoned",
          halt: "none",
        }),
      );
      await prisma.engineeringAgentWorkItem.update({
        where: { id: mismatch.id },
        data: { state: "resolved" },
      });
    }
  }
});

test("a published result is bound in the transaction that records the card's review pull request", async () => {
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const inTx = <T>(work: Parameters<typeof runEngineeringAgentTransaction<T>>[1]) =>
    runEngineeringAgentTransaction(prisma, work);
  // A publish needs a run that started under t1.
  await setMode("t1");
  try {
    // A review pull request belongs to a card a person reviews.
    const fixture = await readyWorkerWithCard({ requiresHumanReview: true });
    const runId = nextRunId();
    const started = await startWithRun(fixture, runId);
    const { workItemId } = await inTx((tx) =>
      openEngineeringAgentWorkItem(tx, {
        kind: "publish",
        causeKey: `publish:${runId}:adapter`,
        runId,
        patchBody: "patch",
        patchDigest: sha256("patch"),
        baseSha: sha1(runId),
        expectedTreeId: sha1("tree"),
      }),
    );
    await inTx((tx) =>
      issueEngineeringAgentCapability(tx, {
        workItemId,
        capability: {
          baseSha: sha1(runId),
          patchDigest: sha256("patch"),
          expectedTreeId: sha1("tree"),
          commit: {
            identity: { name: "Tomverse Engineering Agent", email: "engineering-agent@users.noreply.github.com" },
            baseCommitterDate: "1759000000 +1000",
            runId,
            cardRef: fixture.taskId,
          },
        },
      }),
    );
    // The run ends and its attempt settles to review; then the publisher claims.
    const settled = await withAmuxRouteBudget(
      () =>
        settleAmuxExecution(
          {
            attemptId: started.attemptId,
            worker: fixture.worker,
            instanceId: fixture.instanceId,
            generation: fixture.generation,
            taskRevision: started.taskRevision,
            outcome: "succeeded",
            toStatus: "review",
            actualCostMicrousd: null,
          },
          engineeringRunEndAttachment({ runId, outcome: "t1_queued", halt: "none" }),
        ),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    assert.equal(settled.settled, true);
    const claim = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));

    const prNumber = 900_000 + Math.floor(Math.random() * 90_000);
    const pullRequest = {
      prNumber,
      headSha: sha1("head"),
      verifiedHeadSha: sha1("head"),
      snapshot: { baseSha: sha1(runId), diffDigest: sha256("diff"), treeId: sha1("tree"), invalidatedReviewIds: [] },
    };
    const record = (worker: string, number = prNumber) =>
      withAmuxRouteBudget(
        () =>
          recordAmuxReviewPullRequest(
            { taskId: fixture.taskId, attemptId: started.attemptId, worker, prNumber: number },
            engineeringPublishResultAttachment({
              workItemId,
              fencingToken: claim.fencingToken,
              outcome: "confirmed",
              pullRequest: { ...pullRequest, prNumber: number },
            }),
          ),
        ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
      );

    // Another worker's review takes no number, and nothing of ours is written.
    assert.deepEqual(await record("someone-else"), { recorded: false, reason: "not_the_workers_review" });
    assert.equal((await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: workItemId } })).state, "claimed");
    // An attempt that is not the card's latest takes no number either.
    assert.deepEqual(
      await withAmuxRouteBudget(
        () =>
          recordAmuxReviewPullRequest(
            { taskId: fixture.taskId, attemptId: randomUUID(), worker: fixture.worker, prNumber },
            engineeringPublishResultAttachment({
              workItemId,
              fencingToken: claim.fencingToken,
              outcome: "confirmed",
              pullRequest,
            }),
          ),
        ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
      ),
      { recorded: false, reason: "not_the_workers_review" },
    );

    const done = await record(fixture.worker);
    assert.equal(done.recorded, true);
    const card = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.taskId } });
    assert.equal(card.reviewPrNumber, prNumber);
    assert.equal(card.status, "review");
    const item = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: workItemId } });
    assert.equal(item.state, "published");
    const binding = await prisma.engineeringAgentBinding.findFirstOrThrow({ where: { runId, prNumber } });
    assert.equal(binding.currentPrNumber, prNumber);

    // A different number for the same review is a conflict, and nothing moves.
    assert.deepEqual(await record(fixture.worker, prNumber + 1), { recorded: false, reason: "review_pr_conflict" });

    await inTx((tx) => moveEngineeringAgentBinding(tx, { bindingId: binding.id, to: "closed" }));
    await inTx((tx) => moveEngineeringAgentBinding(tx, { bindingId: binding.id, to: "pruned" }));
  } finally {
    await setMode("shadow");
  }
});

test("a run that may not start leaves no AMUX trace, even on a card AMUX would block", async () => {
  const fixture = await readyWorkerWithCard();
  // Five ended attempts spend the card's attempt budget: a start would block it.
  for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber += 1) {
    await prisma.amuxExecutionAttempt.create({
      data: {
        id: randomUUID(),
        taskId: fixture.taskId,
        worker: fixture.worker,
        workerInstanceId: fixture.instanceId,
        workerGeneration: fixture.generation,
        taskRevision: 0,
        attemptNumber,
        heartbeatAt: new Date(),
        startedAt: new Date(),
        endedAt: new Date(),
        outcome: "failed",
        toStatus: "todo",
        endedBy: fixture.worker,
      },
    });
  }
  const { workItemId: mismatchId } = await runEngineeringAgentTransaction(prisma, (tx) =>
    openEngineeringAgentWorkItem(tx, {
      kind: "state_mismatch",
      causeKey: `mismatch:${fixture.taskId}`,
      runId: null,
      reason: "fixture",
    }),
  );
  try {
    await assert.rejects(
      startWithRun(fixture, nextRunId()),
      (error: unknown) => error instanceof EngineeringAgentStoreRefusedError && error.code === "halted",
    );
    const card = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.taskId } });
    assert.equal(card.status, "todo", "the halted start blocked nothing");
    assert.equal(await prisma.amuxHumanEscalation.count({ where: { taskId: fixture.taskId } }), 0);
  } finally {
    await prisma.engineeringAgentWorkItem.update({ where: { id: mismatchId }, data: { state: "resolved" } });
  }
  // With nothing halting, AMUX's own refusal is AMUX's to record.
  const started = await withAmuxRouteBudget(
    () =>
      startAmuxExecution(
        {
          taskId: fixture.taskId,
          worker: fixture.worker,
          instanceId: fixture.instanceId,
          generation: fixture.generation,
          expectedRevision: 1,
        },
        engineeringRunStartAttachment({ runId: nextRunId(), baseSha: sha1("base") }),
      ),
    ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  );
  assert.deepEqual(started, { started: false, reason: "attempt_budget_exhausted" });
  assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.taskId } })).status, "blocked");
});

test("an active run whose attempt ended halts runs before anyone reports it", async () => {
  const fixture = await readyWorkerWithCard();
  const runId = nextRunId();
  const started = await startWithRun(fixture, runId);
  // AMUX recovery ends the attempt on its own route; no heartbeat has looked yet.
  await reclaimExpiredAmuxExecutions({ now: new Date(Date.now() + 10 * 60_000), limit: 200 });
  const ended = await prisma.amuxExecutionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  assert.ok(ended.endedAt, "recovery ended the attempt");
  const other = await readyWorkerWithCard();
  await assert.rejects(
    startWithRun(other, nextRunId()),
    (error: unknown) => error instanceof EngineeringAgentStoreRefusedError && error.code === "halted",
  );
  assert.equal(await runEngineeringAgentTransaction(prisma, (tx) => openEngineeringAgentRunMismatches(tx)), 1);
  const mismatch = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { causeKey: `run_attempt:${runId}` } });
  assert.equal(currentEngineeringAgentHalt(await readEngineeringAgentHaltState(prisma)), "state_mismatch");

  // A person's action: AMUX's rows locked first, both sides read again.
  const person = {
    user: { id: `eng-agent-owner-${randomUUID()}`, email: "owner@example.test" },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as Session;
  const act = (action: "leave_open" | "close_domain_after_verified_no_write") =>
    runEngineeringAgentTransaction(
      prisma,
      (tx) => resolveEngineeringAgentStateMismatch(tx, { session: person, workItemId: mismatch.id, action }),
      { beforeAuditLock: (tx) => lockEngineeringAgentMismatchAmuxRows(tx, mismatch.id) },
    );
  const left = await act("leave_open");
  assert.equal(left.resolved, false, "leaving it open resolves nothing");
  assert.equal((await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: mismatch.id } })).state, "open");

  // Nothing of the run was ever allowed to write, so the domain side may close.
  const closed = await act("close_domain_after_verified_no_write");
  assert.equal(closed.resolved, true);
  assert.equal((await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: mismatch.id } })).state, "resolved");
  const run = await prisma.engineeringAgentRun.findUniqueOrThrow({ where: { id: runId } });
  assert.deepEqual([run.status, run.outcome], ["abandoned", "abandoned"]);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "engineering_agent.mismatch_acted", targetId: mismatch.id },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(audit.actorUserId, person.user!.id, "a person's action, audited as that person");
  await assert.rejects(
    act("close_domain_after_verified_no_write"),
    (error: unknown) => error instanceof EngineeringAgentStoreRefusedError && error.code === "mismatch_not_open",
  );
});

test("a registration records the generation it created with its request", async () => {
  const worker = `eng-adapter-${randomUUID().slice(0, 12)}`;
  fixtureWorkers.push(worker);
  const requestKey = `register-${randomUUID()}`;
  const outcome = await runAttachedIdempotentEngineeringAgentRequest({
    route: "worker/register",
    requestKey,
    body: { requestKey },
    work: (markCommitted) =>
      withAmuxRouteBudget(
        () =>
          registerAmuxWorkerRuntime(worker, randomUUID(), undefined, {
            prismaCalls: 2,
            work: async (lent, fact) => {
              await markCommitted(engineeringAgentTransactionInAmux(lent), String(fact.generation));
            },
          }),
        ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
      ),
  });
  assert.equal(outcome.kind, "done");
  const generation = outcome.kind === "done" ? outcome.value.generation : -1;
  const record = await prisma.engineeringAgentRequest.findUniqueOrThrow({ where: { key: requestKey } });
  assert.equal(record.resultRef, String(generation));
  // The retry is answered from the record; no second generation is made.
  const replay = await runAttachedIdempotentEngineeringAgentRequest({
    route: "worker/register",
    requestKey,
    body: { requestKey },
    work: () => Promise.reject(new Error("a replay must not run the work")),
  });
  assert.deepEqual(replay, { kind: "replay", state: "committed", resultRef: String(generation) });
  const runtime = await prisma.amuxWorkerRuntime.findUniqueOrThrow({ where: { workerName: worker } });
  assert.equal(runtime.generation, generation);
});

test("an agent registration writes its card and its record in one transaction, once per source identity", async () => {
  const registrationKey = "feature.engineeringAgentRegistration";
  await prisma.appSetting.upsert({
    where: { key: registrationKey },
    create: { key: registrationKey, value: "on" },
    update: { value: "on" },
  });
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const itemKey = `ENG-${randomUUID().slice(0, 8).toUpperCase()}`;
  const itemDigest = sha256(itemKey);
  const roundId = `round-${randomUUID().slice(0, 12)}`;
  const sourceKey = sha256(`engineering-product-backlog|${itemKey}`).toUpperCase();
  const card = {
    agentId: "engineering-agent" as const,
    sourceSystem: "engineering-product-backlog",
    sourceKey,
    sourceVersion: sha1("pinned"),
    sourceDigest: itemDigest,
    title: "Engineering registration fixture",
    priority: "p3" as const,
    proposalDigest: sha256("proposal"),
    scannerVersion: "amux-board-content-scan-v1",
  };
  const record = (id: string) => ({
    id,
    source: "S1" as const,
    pinnedCommit: sha1("pinned"),
    itemKey,
    itemDigest,
    proposalDigest: sha256("proposal"),
    guardResult: "allowed",
    roundId,
  });
  const written: Array<Awaited<ReturnType<typeof recordEngineeringAgentRegistration>>> = [];
  const attach = (id: string) => ({
    prismaCalls: 19,
    work: async (lent: Parameters<typeof engineeringAgentTransactionInAmux>[0], fact: { cardId: string }) => {
      written.push(
        await recordEngineeringAgentRegistration(engineeringAgentTransactionInAmux(lent), {
          ...record(id),
          result: "registered",
          amuxCardId: fact.cardId,
        }),
      );
    },
  });
  try {
    const firstId = randomUUID();
    const first = await withAmuxRouteBudget(
      () => registerAmuxAgentIntakeCard({ card, actor: "engineering-agent-registrar" }, attach(firstId)),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    assert.equal(first.registered, true);
    const cardId = first.registered ? first.cardId : "";
    fixtureTaskIds.push(cardId);
    const stored = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: cardId } });
    assert.equal(stored.status, "backlog");
    assert.equal(stored.kind, "unknown");
    assert.equal(stored.owner, null);
    assert.equal(stored.description, null, "the card holds no proposal text beyond its title");
    const row = await prisma.engineeringAgentRegistration.findUniqueOrThrow({ where: { id: firstId } });
    assert.equal(row.result, "registered");
    assert.equal(row.amuxCardId, cardId);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "amux.intake.agent_registered", targetId: cardId },
    });
    assert.equal(
      (audit.metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY],
      "engineering-agent-registrar",
      "the card is registered under the agent's system actor, not a person",
    );
    assert.equal(audit.actorUserId, null);

    // The same item again: the same card, and the item's row found rather
    // than a unique violation -- a definite answer, with nothing written.
    const secondId = randomUUID();
    const second = await withAmuxRouteBudget(
      () => registerAmuxAgentIntakeCard({ card, actor: "engineering-agent-registrar" }, attach(secondId)),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    assert.deepEqual(second, { registered: true, cardId, created: false });
    assert.deepEqual(written.at(-1), {
      recorded: false,
      existing: { id: firstId, result: "registered", amuxCardId: cardId },
    });
    assert.equal(await prisma.engineeringAgentRegistration.count({ where: { id: secondId } }), 0);

    // A refusal of the item at the digest it already has an answer for adds nothing either.
    const refusedAgain = await runEngineeringAgentTransaction(prisma, (tx) =>
      recordEngineeringAgentRegistration(tx, {
        ...record(randomUUID()),
        guardResult: "title_invalid",
        result: "registration_refused",
        amuxCardId: null,
      }),
    );
    assert.equal(refusedAgain.recorded, false);

    // The same identity with another digest is a conflict and writes nothing.
    const conflict = await withAmuxRouteBudget(
      () =>
        registerAmuxAgentIntakeCard(
          { card: { ...card, sourceDigest: sha256("another revision") }, actor: "engineering-agent-registrar" },
          attach(randomUUID()),
        ),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    assert.deepEqual(conflict, { registered: false, reason: "conflict" });

    // A lost answer read back as partial is a person's decision.
    const partialId = randomUUID();
    const readBack = await runEngineeringAgentTransaction(prisma, (tx) =>
      recordEngineeringAgentRegistrationReadBack(tx, {
        ...record(partialId),
        itemKey: `${itemKey}-B`,
        found: "partial",
      }),
    );
    assert.ok(readBack.recorded && readBack.decisionItemId);
    const partial = await prisma.engineeringAgentRegistration.findUniqueOrThrow({ where: { id: partialId } });
    assert.equal(partial.result, "partial");
    // The fixture plays the person: the decision closes, the registration resolves.
    await prisma.engineeringAgentWorkItem.update({ where: { id: readBack.decisionItemId }, data: { state: "acknowledged" } });
    await prisma.engineeringAgentRegistration.update({ where: { id: partialId }, data: { result: "absent" } });
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: registrationKey } });
  }
});

test("a settlement records the agent's own spend under the agent scope, apart from the attempt's cost", async () => {
  const fixture = await readyWorkerWithCard();
  const runId = nextRunId();
  const started = await startWithRun(fixture, runId);
  const settled = await withAmuxRouteBudget(
    () =>
      settleAmuxExecution(
        {
          attemptId: started.attemptId,
          worker: fixture.worker,
          instanceId: fixture.instanceId,
          generation: fixture.generation,
          taskRevision: started.taskRevision,
          outcome: "succeeded",
          toStatus: "review",
          actualCostMicrousd: null,
          agentUsage: { agentId: "engineering-agent", amountMicrousd: BigInt(12_345) },
        },
        engineeringRunEndAttachment({ runId, outcome: "t2_draft", halt: "none" }),
      ),
    ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  );
  assert.equal(settled.settled, true);
  const rows = await prisma.amuxCostLedgerEntry.findMany({ where: { attemptId: started.attemptId } });
  assert.equal(rows.length, 1, "no reservation or settlement delta rides along");
  const [row] = rows;
  assert.equal(row.scope, "agent");
  assert.equal(row.kind, "agent_usage");
  assert.equal(row.resourceKey, "engineering-agent");
  assert.equal(row.amountMicrousd, BigInt(12_345));
  const window = amuxAgentUsageWindow(row.createdAt);
  assert.equal(row.budgetWindowStartsAt.getTime(), window.startsAt.getTime(), "charged to its UTC month");
  const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  assert.equal(attempt.settledCostMicrousd, null, "the attempt's own cost is untouched");

  // The database keeps the agent scope and the agent kind together.
  await assert.rejects(
    prisma.amuxCostLedgerEntry.create({
      data: {
        scope: "project",
        resourceKey: "engineering-agent",
        budgetWindowStartsAt: window.startsAt,
        budgetWindowEndsAt: window.endsAt,
        taskId: fixture.taskId,
        attemptId: started.attemptId,
        kind: "agent_usage",
        amountMicrousd: BigInt(1),
      },
    }),
    /AmuxCostLedgerEntry_agent_scope_check/,
  );
});

// The whole gate (orchestration policy version 25): with the code latch and
// the execution API both open, the engineering mode alone decides.
const withExecutionApi = async <T>(work: () => Promise<T>): Promise<T> => {
  const previous = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    else process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previous;
  }
};

test("mode off closes a public adapter call before it writes anything to AMUX", async () => {
  await withExecutionApi(async () => {
    try {
      await setMode("shadow");
      assert.equal(await engineeringAgentAmuxAdapterPermittedNow(), true, "shadow with the latch and the API is open");
      await setMode("off");
      assert.equal(await engineeringAgentAmuxAdapterPermittedNow(), false, "mode off closes the gate");
      const before = await prisma.amuxWorkerRuntime.findMany({
        where: { workerName: ENGINEERING_AGENT_AMUX_WORKER },
        select: { generation: true, instanceId: true },
      });
      await assert.rejects(
        registerEngineeringAgentWorker({ instanceId: randomUUID() }),
        (error) => error instanceof EngineeringAgentStoreRefusedError && error.code === "adapter_closed",
      );
      const afterRows = await prisma.amuxWorkerRuntime.findMany({
        where: { workerName: ENGINEERING_AGENT_AMUX_WORKER },
        select: { generation: true, instanceId: true },
      });
      assert.deepEqual(afterRows, before, "no runtime generation was registered");
    } finally {
      await setMode("shadow");
    }
  });
});

test("a closed adapter records a publisher's pull request on the engineering side, never on the card", async () => {
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const inTx = <T>(work: Parameters<typeof runEngineeringAgentTransaction<T>>[1]) =>
    runEngineeringAgentTransaction(prisma, work);
  await setMode("t1");
  try {
    const fixture = await readyWorkerWithCard({ requiresHumanReview: true });
    const runId = nextRunId();
    const started = await startWithRun(fixture, runId);
    const { workItemId } = await inTx((tx) =>
      openEngineeringAgentWorkItem(tx, {
        kind: "publish",
        causeKey: `publish:${runId}:closed-adapter`,
        runId,
        patchBody: "patch",
        patchDigest: sha256("patch"),
        baseSha: sha1(runId),
        expectedTreeId: sha1("tree"),
      }),
    );
    closedAdapterFixtures.push({ runId, workItemId });
    await inTx((tx) =>
      issueEngineeringAgentCapability(tx, {
        workItemId,
        capability: {
          baseSha: sha1(runId),
          patchDigest: sha256("patch"),
          expectedTreeId: sha1("tree"),
          commit: {
            identity: { name: "Tomverse Engineering Agent", email: "engineering-agent@users.noreply.github.com" },
            baseCommitterDate: "1759000000 +1000",
            runId,
            cardRef: fixture.taskId,
          },
        },
      }),
    );
    const settled = await withAmuxRouteBudget(
      () =>
        settleAmuxExecution(
          {
            attemptId: started.attemptId,
            worker: fixture.worker,
            instanceId: fixture.instanceId,
            generation: fixture.generation,
            taskRevision: started.taskRevision,
            outcome: "succeeded",
            toStatus: "review",
            actualCostMicrousd: null,
          },
          engineeringRunEndAttachment({ runId, outcome: "t1_queued", halt: "none" }),
        ),
      ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
    );
    assert.equal(settled.settled, true);
    const claim = await inTx((tx) => claimEngineeringAgentWorkItem(tx, { workItemId, mode: "write", leaseMs: 60_000 }));

    // The pull request now exists; then the mode goes off before the result arrives.
    await setMode("off");
    const prNumber = 900_000 + Math.floor(Math.random() * 90_000);
    const result = await withExecutionApi(() =>
      recordEngineeringAgentPublisherResult({
        workItemId,
        fencingToken: claim.fencingToken,
        outcome: "confirmed",
        pullRequest: {
          prNumber,
          headSha: sha1("head"),
          verifiedHeadSha: sha1("head"),
          snapshot: { baseSha: sha1(runId), diffDigest: sha256("diff"), treeId: sha1("tree"), invalidatedReviewIds: [] },
        },
      }),
    );
    assert.equal(result.recorded, false);
    assert.equal(result.recorded === false ? result.reason : null, "adapter_closed");

    // Recorded on the engineering side: settled, bound, and a mismatch for a person.
    const item = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: workItemId } });
    assert.equal(item.state, "published");
    const binding = await prisma.engineeringAgentBinding.findFirstOrThrow({ where: { runId, prNumber } });
    const mismatch = await prisma.engineeringAgentWorkItem.findFirstOrThrow({
      where: { kind: "state_mismatch", causeKey: `review_pr:${workItemId}` },
    });
    assert.equal(mismatch.state, "open");
    assert.equal(mismatch.reason, "adapter_closed");
    // Never on the card: the number did not reach AMUX.
    const card = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: fixture.taskId } });
    assert.equal(card.reviewPrNumber, null);

    // A person closes it, as section 11 has them do; escalation turns the mode
    // off, and the binding is then closed and pruned under a mode that allows it.
    await closeClosedAdapterFixture({ runId, workItemId });
    assert.equal(
      (await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: mismatch.id } })).state,
      "resolved",
    );
    assert.equal(
      (await prisma.engineeringAgentBinding.findUniqueOrThrow({ where: { id: binding.id } })).state,
      "pruned",
    );
  } finally {
    // Whatever stopped the test, nothing of it stays open to halt the next one.
    for (const fixture of closedAdapterFixtures) await closeClosedAdapterFixture(fixture);
    await setMode("shadow");
  }
});

/** Closes a closed-adapter fixture's mismatch and binding; safe to call twice. */
async function closeClosedAdapterFixture(fixture: { runId: string; workItemId: string }) {
  const open = await prisma.engineeringAgentWorkItem.findFirst({
    where: { kind: "state_mismatch", state: "open", causeKey: `review_pr:${fixture.workItemId}` },
    select: { id: true },
  });
  if (open) {
    const owner = {
      user: { id: `eng-adapter-owner-${randomUUID()}`, email: "owner@example.test" },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    } as Session;
    await runEngineeringAgentTransaction(
      prisma,
      (tx) => resolveEngineeringAgentStateMismatch(tx, { session: owner, workItemId: open.id, action: "escalate_incident" }),
      { beforeAuditLock: (tx) => lockEngineeringAgentMismatchAmuxRows(tx, open.id) },
    );
  }
  // Moving a binding is maintenance, which mode off refuses.
  await setMode("shadow");
  const bindings = await prisma.engineeringAgentBinding.findMany({
    where: { runId: fixture.runId, state: { in: ["open", "closed"] } },
    select: { id: true, state: true },
  });
  for (const binding of bindings) {
    if (binding.state === "open") {
      await runEngineeringAgentTransaction(prisma, (tx) => moveEngineeringAgentBinding(tx, { bindingId: binding.id, to: "closed" }));
    }
    await runEngineeringAgentTransaction(prisma, (tx) => moveEngineeringAgentBinding(tx, { bindingId: binding.id, to: "pruned" }));
  }
}
