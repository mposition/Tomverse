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
  heartbeatAmuxExecution,
  reclaimExpiredAmuxExecutions,
  settleAmuxExecution,
  startAmuxExecution,
} from "@/lib/amux/execution";
import {
  heartbeatAmuxWorkerRuntime,
  registerAmuxWorkerRuntime,
} from "@/lib/amux/workerRuntime";
import {
  ENGINEERING_AGENT_AMUX_ROUTE_BUDGET_MS,
  engineeringRunEndAttachment,
  engineeringRunHeartbeatAttachment,
  engineeringRunStartAttachment,
} from "@/lib/engineeringAgentAmuxAdapter";
import {
  EngineeringAgentStoreRefusedError,
  endEngineeringAgentRun,
  openEngineeringAgentRunMismatches,
  runEngineeringAgentTransaction,
} from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for the engineering adapter
// (docs/policy/engineering-agent.md §8, §11, §14; development-agent-
// orchestration.md, Authority, version 12): the engineering run is written in
// the AMUX writer's own transaction, after every AMUX row lock, so the two are
// one fact or neither happened; and the adapter's settlement runs against
// AMUX's delivery acknowledgement and expired-execution recovery without a
// deadlock. The AMUX writers are called directly with the adapter's
// attachments: the public adapter functions return before any transaction
// while the code latch is false, as the reconciliation tests do for theirs.
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

const setMode = (value: string) =>
  prisma.appSetting.upsert({
    where: { key: MODE_KEY },
    create: { key: MODE_KEY, value },
    update: { value },
  });

// Shadow is enough for a run, and it holds no pull request window open for
// the engineering files that run after this one.
before(async () => {
  await setMode("shadow");
  await prisma.appSetting.deleteMany({ where: { key: FREEZE_KEY } });
});

after(async () => {
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
const nextRunId = () => String((runCounter += 1));

/** A worker that is registered, idle and ready, and a todo card it owns. */
const readyWorkerWithCard = async () => {
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
