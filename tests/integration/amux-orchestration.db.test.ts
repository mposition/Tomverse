import { randomUUID } from "node:crypto";
import { POST as claimPost } from "@/app/api/internal/amux/claim/route";
import { POST as ownedQueuePost } from "@/app/api/internal/amux/owned-queue/route";
import { POST as executionStartPost } from "@/app/api/internal/amux/execution/start/route";
import { POST as executionHeartbeatPost } from "@/app/api/internal/amux/execution/heartbeat/route";
import { POST as executionSettlePost } from "@/app/api/internal/amux/execution/settle/route";
import { POST as deliveryPullPost } from "@/app/api/internal/amux/delivery/pull/route";
import { POST as deliveryAckPost } from "@/app/api/internal/amux/delivery/ack/route";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";
import { scoreAmuxWorkers } from "@/lib/amux/workerRouterCore";
import {
  amuxWorkerRuntimeByName,
  heartbeatAmuxWorkerRuntime,
  registerAmuxWorkerRuntime,
} from "@/lib/amux/workerRuntime";
import {
  AMUX_CLAIM_RESERVATION_MS,
  heartbeatAmuxExecution,
  reclaimExpiredAmuxClaims,
  reclaimExpiredAmuxExecutions,
  settleAmuxExecution,
  startAmuxExecution,
} from "@/lib/amux/execution";
import {
  acknowledgeAmuxWorkDelivery,
  pullAmuxWorkDelivery,
} from "@/lib/amux/delivery";
import {
  claimUnownedTodo,
  listDispatchable,
  type AmuxDecisionSignals,
} from "@/lib/amux/store";

const SCORING_VERSION = "amux-global-priority-v1";

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();

  if (!testRaw) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  if (runtimeRaw !== testRaw) {
    throw new Error(
      "REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test",
    );
  }

  const url = new URL(testRaw);
  if (url.searchParams.get("schema") !== "tomverse_amux_test") {
    throw new Error(
      "REFUSE: AMUX DB tests require schema=tomverse_amux_test",
    );
  }

  if (url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: AMUX DB tests require a direct PostgreSQL URL");
  }
};

requireDedicatedAmuxTestDatabase();

after(async () => {
  await prisma.$disconnect();
});

const signals = (
  overrides: Partial<AmuxDecisionSignals> = {},
): AmuxDecisionSignals => ({
  pin: 0,
  age_hours: 0,
  type_weight: 12,
  priority_weight: 20,
  dependents: 0,
  dependent_weight: 0,
  drag: 0,
  ...overrides,
});

const createTodo = async (prefix: string) => {
  const id = `${prefix}-${randomUUID()}`;

  await prisma.amuxWorkItem.create({
    data: {
      id,
      title: `AMUX DB regression ${id}`,
      status: "todo",
      kind: "code",
      priority: "p1",
      pinned: false,
      drag: 0,
    },
  });

  return id;
};

test("two concurrent claimants produce exactly one owner and one route decision", async () => {
  const taskId = await createTodo("amux-race");

  const [left, right] = await Promise.all([
    claimUnownedTodo({
      taskId,
      worker: "amux-db-worker-a",
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    }),
    claimUnownedTodo({
      taskId,
      worker: "amux-db-worker-b",
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    }),
  ]);

  const winners = [left, right].filter(
    (result): result is NonNullable<typeof result> => result !== null,
  );

  assert.equal(winners.length, 1);

  const task = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: taskId },
  });

  assert.ok(
    task.owner === "amux-db-worker-a" ||
      task.owner === "amux-db-worker-b",
  );
  assert.equal(task.revision, 1);
  assert.ok(task.claimedAt instanceof Date);

  const decisions = await prisma.amuxRouteDecision.findMany({
    where: { taskId },
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.worker, task.owner);
  assert.equal(decisions[0]?.taskRevision, 0);
  assert.equal(decisions[0]?.schedulerScore, 32);
  assert.equal(decisions[0]?.scoringVersion, SCORING_VERSION);

  // Keep historical route evidence append-only, but keep this fixture out of
  // later dispatchable reads.
  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: { status: "done" },
  });
});

test("a failed route-decision insert rolls the owner claim back", async () => {
  const taskId = await createTodo("amux-rollback");

  await assert.rejects(
    claimUnownedTodo({
      taskId,
      worker: "amux-db-worker-overflow",
      expectedRevision: 0,

      // PostgreSQL INTEGER cannot store this. The decision insert must fail
      // after the conditional owner UPDATE, causing the whole Prisma
      // transaction to roll back.
      schedulerScore: 2_147_483_648,

      scoringVersion: SCORING_VERSION,
      signals: signals(),
    }),
  );

  const task = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: taskId },
  });

  assert.equal(task.owner, null);
  assert.equal(task.revision, 0);
  assert.equal(task.claimedAt, null);

  const decisionCount = await prisma.amuxRouteDecision.count({
    where: { taskId },
  });

  assert.equal(decisionCount, 0);

  await prisma.amuxWorkItem.delete({
    where: { id: taskId },
  });
});

test("cancelled dependencies fail closed while done dependencies unblock work", async () => {
  const dependencyId = await createTodo("amux-dependency");
  const dependentId = await createTodo("amux-dependent");

  await prisma.amuxWorkItem.update({
    where: { id: dependencyId },
    data: { status: "cancelled" },
  });

  await prisma.amuxWorkDependency.create({
    data: {
      taskId: dependentId,
      dependencyId,
    },
  });

  let dispatchable = await listDispatchable();

  assert.equal(
    dispatchable.some((task) => task.id === dependentId),
    false,
  );

  await prisma.amuxWorkItem.update({
    where: { id: dependencyId },
    data: { status: "done" },
  });

  dispatchable = await listDispatchable();

  const unblocked = dispatchable.find(
    (task) => task.id === dependentId,
  );

  assert.ok(unblocked);

  await prisma.amuxWorkDependency.delete({
    where: {
      taskId_dependencyId: {
        taskId: dependentId,
        dependencyId,
      },
    },
  });

  await prisma.amuxWorkItem.deleteMany({
    where: {
      id: { in: [dependencyId, dependentId] },
    },
  });
});

test("live dependents contribute to dependent_count exactly once", async () => {
  const parentId = await createTodo("amux-parent");
  const childId = await createTodo("amux-child");

  await prisma.amuxWorkDependency.create({
    data: {
      taskId: childId,
      dependencyId: parentId,
    },
  });

  const dispatchable = await listDispatchable();

  const parent = dispatchable.find(
    (task) => task.id === parentId,
  );

  assert.ok(parent);
  assert.equal(parent.dependent_count, 1);

  // The child waits on the unfinished parent.
  assert.equal(
    dispatchable.some((task) => task.id === childId),
    false,
  );

  await prisma.amuxWorkDependency.delete({
    where: {
      taskId_dependencyId: {
        taskId: childId,
        dependencyId: parentId,
      },
    },
  });

  await prisma.amuxWorkItem.deleteMany({
    where: {
      id: { in: [parentId, childId] },
    },
  });
});

test("routing snapshot fails closed without an explicit worker catalog", async () => {
  const taskId = await createTodo("amux-routing-no-catalog");

  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: {
      classification: {
        task_kind: "migration",
        complexity: 8,
        risk: 3,
        files_expected: ["prisma/schema.prisma", "migration.sql"],
      },
    },
  });

  const previousCatalog =
    process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  try {
    const snapshot = await buildAmuxRoutingSnapshot(taskId, 0);

    assert.deepEqual(snapshot, {
      eligible: false,
      execution_ready: false,
      reason: "worker_catalog_unavailable",
      task: null,
      candidates: [],
    });
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON =
        previousCatalog;
    }

    await prisma.amuxWorkItem.delete({
      where: { id: taskId },
    });
  }
});

test("routing snapshot exposes explicit workers without inventing runtime evidence", async () => {
  const taskId = await createTodo("amux-routing-catalog");

  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: {
      classification: {
        task_kind: "migration",
        complexity: 8,
        risk: 3,
        files_expected: ["a.ts", "b.ts"],
      },
    },
  });

  const previousCatalog =
    process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
    {
      worker_name: "z-migration",
      provider: "DEVIN",
      routing_roles: ["migration", "multi_file", "migration"],
    },
    {
      worker_name: "a-implementation",
      provider: "CODEX",
      model: "explicit-model",
      routing_roles: ["implementation"],
    },
  ]);

  try {
    const snapshot = await buildAmuxRoutingSnapshot(taskId, 0);

    assert.equal(snapshot.eligible, true);

    if (!snapshot.eligible) {
      assert.fail("expected an eligible routing snapshot");
    }

    assert.equal(snapshot.execution_ready, false);

    assert.deepEqual(snapshot.task, {
      task_kind: "migration",
      complexity: 8,
      risk: 3,
      files_expected: 2,
    });

    assert.deepEqual(
      snapshot.candidates.map((candidate) => candidate.worker.worker_name),
      ["a-implementation", "z-migration"],
    );

    const implementation = snapshot.candidates[0];
    const migration = snapshot.candidates[1];

    assert.ok(implementation);
    assert.ok(migration);

    assert.equal(implementation.worker.provider, "codex");
    assert.equal(implementation.worker.model, "explicit-model");

    assert.equal(migration.worker.provider, "devin");
    assert.deepEqual(
      migration.worker.routing_roles,
      ["migration", "multi_file"],
    );

    for (const candidate of snapshot.candidates) {
      assert.equal(candidate.worker.running, false);
      assert.equal(candidate.worker.status, "stopped");
      assert.equal(candidate.worker.dispatch_ready, false);

      assert.equal(candidate.predicted_success, null);
      assert.equal(candidate.quota_remaining, null);
      assert.equal(candidate.expected_speed, null);
      assert.equal(candidate.low_rework, null);
      assert.equal(candidate.low_human_attention, null);
      assert.equal(candidate.cost_efficiency, null);
      assert.equal(candidate.provider_exhausted, false);
    }
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON =
        previousCatalog;
    }

    await prisma.amuxWorkItem.delete({
      where: { id: taskId },
    });
  }
});


test("claim persists scheduler and worker-router evidence in one append-only decision", async () => {
  const taskId = await createTodo("amux-decision-evidence");
  const worker = "codex-evidence";

  const evidence = {
    scheduler: signals(),
    routing: {
      scoring_version: "amux-worker-router-v1",
      preferred_worker: worker,
      selected_worker: worker,
      preferred_score: 0.75,
      selected_score: 0.7,
      candidates: [
        {
          worker_name: worker,
          provider: "codex",
          breakdown: {
            task_fit: {
              role_fit: 1,
              provider_fit: 1,
              combined: 1,
              large_task: false,
            },
            predicted_success: {
              value: 0.5,
              observed: false,
            },
            quota_remaining: {
              value: 0.5,
              observed: false,
            },
            expected_speed: {
              value: 0.5,
              observed: false,
            },
            low_rework: {
              value: 0.5,
              observed: false,
            },
            low_human_attention: {
              value: 0.5,
              observed: false,
            },
            cost_efficiency: {
              value: 0.5,
              observed: false,
            },
            selected_score: 0.7,
            intrinsic_score: 0.75,
            operationally_allowed: true,
            provider_exhausted: false,
            selected_eligible: true,
          },
        },
      ],
    },
  };

  const claim = await claimUnownedTodo({
    taskId,
    worker,
    expectedRevision: 0,
    schedulerScore: 32,
    scoringVersion: SCORING_VERSION,
    signals: evidence,
  });

  assert.ok(claim);

  const decision = await prisma.amuxRouteDecision.findUniqueOrThrow({
    where: { id: claim.decisionId },
  });

  assert.equal(decision.worker, worker);
  assert.deepEqual(decision.signals, evidence);

  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: { status: "done" },
  });
});

test("claim API refuses ownership before execution lifecycle is ready", async () => {
  const taskId = await createTodo("amux-api-lifecycle-gate");
  const worker = "codex-evidence";
  const secret = "amux-test-secret-0123456789-abcdef";

  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: {
      classification: {
        task_kind: "feature",
        complexity: 4,
        risk: 1,
        files_expected: ["a.ts"],
      },
    },
  });

  const previousSecret =
    process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousCatalog =
    process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON =
    JSON.stringify([
      {
        worker_name: worker,
        provider: "CODEX",
        routing_roles: ["feature", "implementation"],
      },
    ]);

  try {
    /*
     * This test targets the execution lifecycle gate, not routing evidence.
     * Build the exact server-owned routing evidence first so authoritative
     * routing validation succeeds and the request reaches execution_ready.
     */
    const snapshot =
      await buildAmuxRoutingSnapshot(
        taskId,
        0,
      );

    assert.equal(snapshot.eligible, true);

    if (!snapshot.eligible) {
      throw new Error(
        "expected authoritative routing snapshot",
      );
    }

    const routing =
      scoreAmuxWorkers(
        snapshot.task,
        snapshot.candidates,
      );

    assert.equal(
      routing.selected_worker,
      worker,
    );

    const evidence = {
      scheduler: signals(),
      routing: {
        scoring_version:
          "amux-worker-router-v1",
        ...routing,
      },
    };

    const response = await claimPost(
      new Request(
        "http://localhost/api/internal/amux/claim",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task_id: taskId,
            worker,
            expected_revision: 0,
            decision: {
              scheduler_score: 32,
              scoring_version: SCORING_VERSION,
              signals: evidence,
            },
          }),
        },
      ),
    );

    const body = await response.json();

    assert.equal(
      response.status,
      409,
      `unexpected response: ${JSON.stringify(body)}`,
    );

    assert.deepEqual(body, {
      claimed: false,
      reason: "execution_lifecycle_unavailable",
    });

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(task.owner, null);
    assert.equal(task.revision, 0);
    assert.equal(task.claimedAt, null);

    assert.equal(
      await prisma.amuxRouteDecision.count({
        where: { taskId },
      }),
      0,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET =
        previousSecret;
    }

    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON =
        previousCatalog;
    }

    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});


test("worker runtime replacement fences the previous generation", async () => {
  const workerName = `amux-runtime-${randomUUID()}`;
  const firstInstance = randomUUID();
  const secondInstance = randomUUID();

  const startedAt = new Date();
  const firstHeartbeatAt = new Date(startedAt.getTime() + 1_000);
  const replacementAt = new Date(startedAt.getTime() + 2_000);
  const staleHeartbeatAt = new Date(startedAt.getTime() + 3_000);
  const secondHeartbeatAt = new Date(startedAt.getTime() + 4_000);

  try {
    const first = await registerAmuxWorkerRuntime(
      workerName,
      firstInstance,
      startedAt,
    );

    assert.equal(first.workerName, workerName);
    assert.equal(first.instanceId, firstInstance);
    assert.equal(first.generation, 1);
    assert.equal(first.status, "starting");
    assert.equal(first.dispatchReady, false);

    const firstHeartbeat = await heartbeatAmuxWorkerRuntime({
      workerName,
      instanceId: firstInstance,
      generation: first.generation,
      status: "idle",
      dispatchReady: true,
      now: firstHeartbeatAt,
    });

    assert.equal(firstHeartbeat.accepted, true);

    const afterFirstHeartbeat =
      await amuxWorkerRuntimeByName([workerName]);

    const firstLive = afterFirstHeartbeat.get(workerName);

    assert.ok(firstLive);
    assert.equal(firstLive.instanceId, firstInstance);
    assert.equal(firstLive.generation, 1);
    assert.equal(firstLive.status, "idle");
    assert.equal(firstLive.dispatchReady, true);

    /*
     * A replacement process registers the same logical worker.
     * Registration itself must fence generation 1 and reset the runtime to
     * starting/not-ready before the replacement reports an idle boundary.
     */
    const replacement = await registerAmuxWorkerRuntime(
      workerName,
      secondInstance,
      replacementAt,
    );

    assert.equal(replacement.instanceId, secondInstance);
    assert.equal(replacement.generation, 2);
    assert.equal(replacement.status, "starting");
    assert.equal(replacement.dispatchReady, false);

    /*
     * The old process wakes up late. Its lease had not necessarily expired,
     * but its generation is stale, so it must still lose the CAS.
     */
    const staleHeartbeat = await heartbeatAmuxWorkerRuntime({
      workerName,
      instanceId: firstInstance,
      generation: 1,
      status: "idle",
      dispatchReady: true,
      now: staleHeartbeatAt,
    });

    assert.equal(staleHeartbeat.accepted, false);

    const afterStaleHeartbeat =
      await amuxWorkerRuntimeByName([workerName]);

    const stillReplacement =
      afterStaleHeartbeat.get(workerName);

    assert.ok(stillReplacement);
    assert.equal(
      stillReplacement.instanceId,
      secondInstance,
    );
    assert.equal(stillReplacement.generation, 2);
    assert.equal(stillReplacement.status, "starting");
    assert.equal(stillReplacement.dispatchReady, false);

    const secondHeartbeat = await heartbeatAmuxWorkerRuntime({
      workerName,
      instanceId: secondInstance,
      generation: 2,
      status: "idle",
      dispatchReady: true,
      now: secondHeartbeatAt,
    });

    assert.equal(secondHeartbeat.accepted, true);

    const finalRuntime =
      (await amuxWorkerRuntimeByName([workerName])).get(
        workerName,
      );

    assert.ok(finalRuntime);
    assert.equal(finalRuntime.instanceId, secondInstance);
    assert.equal(finalRuntime.generation, 2);
    assert.equal(finalRuntime.status, "idle");
    assert.equal(finalRuntime.dispatchReady, true);
    assert.equal(
      finalRuntime.heartbeatAt.getTime(),
      secondHeartbeatAt.getTime(),
    );
  } finally {
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName },
    });
  }
});

test("execution start and settle are fenced by task revision and worker generation", async () => {
  const worker = `amux-exec-${randomUUID()}`;
  const instanceId = randomUUID();
  const taskId = await createTodo("amux-execution-success");

  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime = await registerAmuxWorkerRuntime(
      worker,
      instanceId,
      base,
    );

    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });

    assert.equal(ready.accepted, true);

    const started = await startAmuxExecution({
      taskId,
      worker,
      instanceId,
      generation: runtime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 1_000),
    });

    if (!started.started) {
      throw new Error(`execution did not start: ${started.reason}`);
    }

    assert.equal(started.taskRevision, 2);

    const during = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(during.status, "doing");
    assert.equal(during.owner, worker);
    assert.equal(during.revision, 2);

    const busyRuntime =
      await prisma.amuxWorkerRuntime.findUniqueOrThrow({
        where: { workerName: worker },
      });

    assert.equal(busyRuntime.status, "busy");
    assert.equal(busyRuntime.dispatchReady, false);

    const settled = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "review",
      now: new Date(base.getTime() + 2_000),
    });

    assert.deepEqual(settled, {
      settled: true,
      taskRevision: 3,
    });

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(task.status, "review");
    assert.equal(task.owner, worker);
    assert.equal(task.revision, 3);

    const attempt =
      await prisma.amuxExecutionAttempt.findUniqueOrThrow({
        where: { id: started.attemptId },
      });

    assert.equal(attempt.outcome, "succeeded");
    assert.equal(attempt.toStatus, "review");
    assert.equal(attempt.endedBy, worker);
    assert.equal(attempt.leaseExpiresAt, null);
    assert.ok(attempt.endedAt);
  } finally {
    await prisma.amuxWorkDelivery.deleteMany({
      where: { taskId },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: { taskId },
    });
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("replacement worker generation cannot heartbeat or settle the old execution attempt", async () => {
  const worker = `amux-exec-fence-${randomUUID()}`;
  const firstInstance = randomUUID();
  const replacementInstance = randomUUID();
  const taskId = await createTodo("amux-execution-fence");

  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const firstRuntime = await registerAmuxWorkerRuntime(
      worker,
      firstInstance,
      base,
    );

    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId: firstInstance,
      generation: firstRuntime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });

    assert.equal(ready.accepted, true);

    const started = await startAmuxExecution({
      taskId,
      worker,
      instanceId: firstInstance,
      generation: firstRuntime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 1_000),
    });

    if (!started.started) {
      throw new Error(`execution did not start: ${started.reason}`);
    }

    const replacement = await registerAmuxWorkerRuntime(
      worker,
      replacementInstance,
      new Date(base.getTime() + 2_000),
    );

    assert.equal(
      replacement.generation,
      firstRuntime.generation + 1,
    );

    const staleHeartbeat = await heartbeatAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId: firstInstance,
      generation: firstRuntime.generation,
      taskRevision: started.taskRevision,
      now: new Date(base.getTime() + 3_000),
    });

    assert.equal(staleHeartbeat, false);

    const staleSettle = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId: firstInstance,
      generation: firstRuntime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "done",
      now: new Date(base.getTime() + 4_000),
    });

    assert.deepEqual(staleSettle, {
      settled: false,
      reason: "fenced_out",
    });

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(task.status, "doing");
    assert.equal(task.owner, worker);
    assert.equal(task.revision, started.taskRevision);

    const attempt =
      await prisma.amuxExecutionAttempt.findUniqueOrThrow({
        where: { id: started.attemptId },
      });

    assert.equal(attempt.endedAt, null);
    assert.equal(attempt.outcome, null);
    assert.notEqual(attempt.leaseExpiresAt, null);
  } finally {
    await prisma.amuxWorkDelivery.deleteMany({
      where: { taskId },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: { taskId },
    });
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("execution API is fail-closed by default and preserves the execution fences when enabled", async () => {
  const taskId = await createTodo("amux-execution-api");
  const worker = `amux-api-${randomUUID()}`;
  const instanceId = randomUUID();
  const secret = "amux-test-secret-0123456789-abcdef";
  const base = new Date();

  const previousSecret =
    process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi =
    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime = await registerAmuxWorkerRuntime(
      worker,
      instanceId,
      base,
    );

    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });

    assert.equal(ready.accepted, true);

    const disabledResponse = await executionStartPost(
      new Request(
        "http://localhost/api/internal/amux/execution/start",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task_id: taskId,
            worker,
            instance_id: instanceId,
            generation: runtime.generation,
            expected_revision: 1,
          }),
        },
      ),
    );

    assert.equal(disabledResponse.status, 409);

    assert.deepEqual(await disabledResponse.json(), {
      started: false,
      reason: "execution_api_disabled",
    });

    const untouched =
      await prisma.amuxWorkItem.findUniqueOrThrow({
        where: { id: taskId },
      });

    assert.equal(untouched.status, "todo");
    assert.equal(untouched.revision, 1);

    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED =
      "1";

    const startResponse = await executionStartPost(
      new Request(
        "http://localhost/api/internal/amux/execution/start",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task_id: taskId,
            worker,
            instance_id: instanceId,
            generation: runtime.generation,
            expected_revision: 1,
          }),
        },
      ),
    );

    assert.equal(startResponse.status, 200);

    const startBody = (await startResponse.json()) as {
      started: true;
      attempt_id: string;
      task_revision: number;
    };

    assert.equal(startBody.started, true);
    assert.equal(startBody.task_revision, 2);

    const heartbeatResponse =
      await executionHeartbeatPost(
        new Request(
          "http://localhost/api/internal/amux/execution/heartbeat",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              attempt_id: startBody.attempt_id,
              worker,
              instance_id: instanceId,
              generation: runtime.generation,
              task_revision:
                startBody.task_revision,
            }),
          },
        ),
      );

    assert.equal(heartbeatResponse.status, 200);
    assert.deepEqual(
      await heartbeatResponse.json(),
      {
        accepted: true,
      },
    );

    const settleResponse =
      await executionSettlePost(
        new Request(
          "http://localhost/api/internal/amux/execution/settle",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              attempt_id: startBody.attempt_id,
              worker,
              instance_id: instanceId,
              generation: runtime.generation,
              task_revision:
                startBody.task_revision,
              outcome: "succeeded",
              to_status: "review",
            }),
          },
        ),
      );

    assert.equal(settleResponse.status, 200);

    assert.deepEqual(await settleResponse.json(), {
      settled: true,
      taskRevision: 3,
    });

    const actions = await prisma.adminAuditLog.findMany({
      where: {
        targetType: "AmuxWorkItem",
        targetId: taskId,
        action: {
          in: [
            "amux.execution.started",
            "amux.execution.settled",
          ],
        },
      },
      orderBy: [
        {
          createdAt: "asc",
        },
        {
          id: "asc",
        },
      ],
      select: {
        action: true,
        actorUserId: true,
        actorEmail: true,
      },
    });

    assert.deepEqual(
      actions.map((entry) => entry.action),
      [
        "amux.execution.started",
        "amux.execution.settled",
      ],
    );

    for (const entry of actions) {
      assert.equal(entry.actorUserId, null);
      assert.equal(entry.actorEmail, null);
    }
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET =
        previousSecret;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED =
        previousExecutionApi;
    }

    await prisma.amuxWorkDelivery.deleteMany({
      where: { taskId },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: { taskId },
    });

    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });

    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("expired execution recovery returns only the still-current attempt to Todo and audits the recovery", async () => {
  const taskId = await createTodo("amux-execution-expired");
  const worker = `amux-expired-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime = await registerAmuxWorkerRuntime(
      worker,
      instanceId,
      base,
    );

    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });

    assert.equal(ready.accepted, true);

    const started = await startAmuxExecution({
      taskId,
      worker,
      instanceId,
      generation: runtime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 1_000),
    });

    if (!started.started) {
      throw new Error(
        `execution did not start: ${started.reason}`,
      );
    }

    const afterExpiry = new Date(
      started.leaseExpiresAt.getTime() + 1_000,
    );

    const reclaimed =
      await reclaimExpiredAmuxExecutions({
        now: afterExpiry,
        limit: 20,
      });

    assert.equal(reclaimed, 1);

    const task =
      await prisma.amuxWorkItem.findUniqueOrThrow({
        where: { id: taskId },
      });

    assert.equal(task.status, "todo");
    assert.equal(task.owner, null);
    assert.equal(task.claimedAt, null);
    assert.equal(task.revision, 3);

    const attempt =
      await prisma.amuxExecutionAttempt.findUniqueOrThrow({
        where: { id: started.attemptId },
      });

    assert.equal(attempt.outcome, "expired");
    assert.equal(attempt.toStatus, "todo");
    assert.equal(attempt.leaseExpiresAt, null);
    assert.ok(attempt.endedAt);

    const lateSettle = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "done",
      now: new Date(afterExpiry.getTime() + 1_000),
    });

    assert.deepEqual(lateSettle, {
      settled: false,
      reason: "fenced_out",
    });

    const audit =
      await prisma.adminAuditLog.findFirst({
        where: {
          action: "amux.execution.expired",
          targetType: "AmuxWorkItem",
          targetId: taskId,
        },
        orderBy: {
          createdAt: "desc",
        },
        select: {
          actorUserId: true,
          actorEmail: true,
          metadata: true,
        },
      });

    assert.ok(audit);
    assert.equal(audit.actorUserId, null);
    assert.equal(audit.actorEmail, null);
  } finally {
    await prisma.amuxWorkDelivery.deleteMany({
      where: { taskId },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: { taskId },
    });

    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });

    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("owned queue exposes only runnable owner-assigned Todo work with delivery fields", async () => {
  const ownedId = await createTodo("amux-owned-queue");
  const unownedId = await createTodo("amux-unowned-queue");
  const worker = `amux-owned-${randomUUID()}`;
  const secret = "amux-test-secret-0123456789-abcdef";
  const claimedAt = new Date();

  const previousSecret =
    process.env.TOMVERSE_AMUX_SYNC_SECRET;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;

  try {
    await prisma.amuxWorkItem.update({
      where: {
        id: ownedId,
      },
      data: {
        owner: worker,
        claimedAt,
        description:
          "Delivery body for the selected worker.",
        kind: "code",
        priority: "p1",
        revision: 4,
      },
    });

    const response = await ownedQueuePost(
      new Request(
        "http://localhost/api/internal/amux/owned-queue",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      ),
    );

    assert.equal(response.status, 200);

    const rows = (await response.json()) as Array<{
      id: string;
      title: string;
      description: string | null;
      kind: string;
      priority: string;
      owner: string;
      revision: number;
      claimed_at: string | null;
      created_at: string;
    }>;

    const owned = rows.find(
      (row) => row.id === ownedId,
    );

    assert.ok(owned);
    assert.equal(owned.owner, worker);
    assert.equal(owned.revision, 4);
    assert.equal(owned.kind, "code");
    assert.equal(owned.priority, "p1");
    assert.equal(
      owned.description,
      "Delivery body for the selected worker.",
    );
    assert.equal(
      new Date(owned.claimed_at ?? "").getTime(),
      claimedAt.getTime(),
    );

    assert.equal(
      rows.some((row) => row.id === unownedId),
      false,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET =
        previousSecret;
    }

    await prisma.amuxWorkItem.deleteMany({
      where: {
        id: {
          in: [ownedId, unownedId],
        },
      },
    });
  }
});

test("execution start atomically creates durable delivery and pull ack remain idempotent", async () => {
  const taskId = await createTodo("amux-delivery");
  const worker = `amux-delivery-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();

  const secret =
    "amux-delivery-test-secret-0123456789-abcdef";

  const previousSecret =
    process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi =
    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED =
    "1";

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime =
      await registerAmuxWorkerRuntime(
        worker,
        instanceId,
        base,
      );

    const ready =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId,
        generation: runtime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 500,
        ),
      });

    assert.equal(ready.accepted, true);

    const started = await startAmuxExecution({
      taskId,
      worker,
      instanceId,
      generation: runtime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 1_000),
    });

    if (!started.started) {
      throw new Error(
        `execution did not start: ${started.reason}`,
      );
    }

    /*
     * started=true now guarantees that the execution attempt and exactly one
     * queued durable delivery committed in the same transaction.
     */
    const atomicDelivery =
      await prisma.amuxWorkDelivery.findUniqueOrThrow({
        where: {
          attemptId: started.attemptId,
        },
      });

    assert.equal(
      atomicDelivery.taskId,
      taskId,
    );
    assert.equal(
      atomicDelivery.worker,
      worker,
    );
    assert.equal(
      atomicDelivery.workerInstanceId,
      instanceId,
    );
    assert.equal(
      atomicDelivery.workerGeneration,
      runtime.generation,
    );
    assert.equal(
      atomicDelivery.taskRevision,
      started.taskRevision,
    );
    assert.equal(
      atomicDelivery.status,
      "queued",
    );
    assert.equal(
      atomicDelivery.receiptId,
      null,
    );

    assert.ok(
      atomicDelivery.prompt.includes(
        `Task: ${taskId}`,
      ),
    );
    assert.ok(
      atomicDelivery.prompt.includes(
        `Execution attempt: ${started.attemptId}`,
      ),
    );
    assert.ok(
      atomicDelivery.prompt.includes(
        `Task revision: ${started.taskRevision}`,
      ),
    );

    const prompt =
      atomicDelivery.prompt;

    assert.equal(
      await prisma.amuxWorkDelivery.count({
        where: {
          attemptId: started.attemptId,
        },
      }),
      1,
    );

    const pullRequest = () =>
      deliveryPullPost(
        new Request(
          "http://localhost/api/internal/amux/delivery/pull",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              worker,
              instance_id: instanceId,
              generation: runtime.generation,
            }),
          },
        ),
      );

    const firstPull = await pullRequest();

    assert.equal(firstPull.status, 200);

    const firstPullBody =
      (await firstPull.json()) as {
        available: boolean;
        delivery: {
          attempt_id: string;
          task_id: string;
          task_revision: number;
          prompt: string;
          receipt_id: string;
          lease_expires_at: string;
        };
      };

    assert.equal(
      firstPullBody.available,
      true,
    );
    assert.equal(
      firstPullBody.delivery.attempt_id,
      started.attemptId,
    );
    assert.equal(
      firstPullBody.delivery.task_id,
      taskId,
    );
    assert.equal(
      firstPullBody.delivery.task_revision,
      started.taskRevision,
    );
    assert.equal(
      firstPullBody.delivery.prompt,
      prompt,
    );

    const secondPull = await pullRequest();

    assert.equal(secondPull.status, 200);

    const secondPullBody =
      (await secondPull.json()) as typeof firstPullBody;

    assert.equal(
      secondPullBody.delivery.receipt_id,
      firstPullBody.delivery.receipt_id,
    );

    const wrongAck =
      await deliveryAckPost(
        new Request(
          "http://localhost/api/internal/amux/delivery/ack",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              attempt_id: started.attemptId,
              receipt_id: randomUUID(),
              worker,
              instance_id: instanceId,
              generation: runtime.generation,
              task_revision:
                started.taskRevision,
            }),
          },
        ),
      );

    assert.equal(wrongAck.status, 409);

    const ackRequest = () =>
      deliveryAckPost(
        new Request(
          "http://localhost/api/internal/amux/delivery/ack",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              attempt_id: started.attemptId,
              receipt_id:
                firstPullBody.delivery.receipt_id,
              worker,
              instance_id: instanceId,
              generation: runtime.generation,
              task_revision:
                started.taskRevision,
            }),
          },
        ),
      );

    const firstAck = await ackRequest();

    assert.equal(firstAck.status, 200);

    assert.deepEqual(
      await firstAck.json(),
      {
        acknowledged: true,
        idempotent: false,
      },
    );

    const secondAck = await ackRequest();

    assert.equal(secondAck.status, 200);

    assert.deepEqual(
      await secondAck.json(),
      {
        acknowledged: true,
        idempotent: true,
      },
    );

    const delivery =
      await prisma.amuxWorkDelivery.findUniqueOrThrow({
        where: {
          attemptId: started.attemptId,
        },
      });

    assert.equal(
      delivery.status,
      "acknowledged",
    );
    assert.equal(
      delivery.receiptId,
      firstPullBody.delivery.receipt_id,
    );
    assert.equal(
      delivery.leaseExpiresAt,
      null,
    );
    assert.ok(delivery.acknowledgedAt);

    const settled = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "done",
      now: new Date(base.getTime() + 2_000),
    });

    assert.equal(settled.settled, true);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET =
        previousSecret;
    }

    if (previousExecutionApi === undefined) {
      delete process.env
        .TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED =
        previousExecutionApi;
    }

    await prisma.amuxWorkDelivery.deleteMany({
      where: { taskId },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: { taskId },
    });

    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });

    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("replacement runtime cannot consume an old delivery and expiry cancels it without changing the replacement generation", async () => {
  const taskId =
    await createTodo("amux-delivery-replacement");

  const worker =
    `amux-delivery-replacement-${randomUUID()}`;

  const firstInstance = randomUUID();
  const replacementInstance = randomUUID();
  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const firstRuntime =
      await registerAmuxWorkerRuntime(
        worker,
        firstInstance,
        base,
      );

    const ready =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId: firstInstance,
        generation:
          firstRuntime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 500,
        ),
      });

    assert.equal(ready.accepted, true);

    const started =
      await startAmuxExecution({
        taskId,
        worker,
        instanceId: firstInstance,
        generation:
          firstRuntime.generation,
        expectedRevision: 1,
        now: new Date(
          base.getTime() + 1_000,
        ),
      });

    if (!started.started) {
      throw new Error(
        `execution did not start: ${started.reason}`,
      );
    }

    const queued =
      await prisma.amuxWorkDelivery.findUniqueOrThrow({
        where: {
          attemptId: started.attemptId,
        },
      });

    assert.equal(queued.status, "queued");
    assert.equal(
      queued.workerInstanceId,
      firstInstance,
    );
    assert.equal(
      queued.workerGeneration,
      firstRuntime.generation,
    );
    assert.equal(
      queued.taskRevision,
      started.taskRevision,
    );

    const replacement =
      await registerAmuxWorkerRuntime(
        worker,
        replacementInstance,
        new Date(
          base.getTime() + 2_000,
        ),
      );

    assert.equal(
      replacement.generation,
      firstRuntime.generation + 1,
    );

    const replacementReady =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId:
          replacementInstance,
        generation:
          replacement.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 2_500,
        ),
      });

    assert.equal(
      replacementReady.accepted,
      true,
    );

    const replacementPull =
      await pullAmuxWorkDelivery({
        worker,
        instanceId:
          replacementInstance,
        generation:
          replacement.generation,
        now: new Date(
          base.getTime() + 3_000,
        ),
      });

    assert.deepEqual(
      replacementPull,
      {
        available: false,
        reason: "runtime_not_ready",
      },
    );

    const afterExpiry = new Date(
      started.leaseExpiresAt.getTime() + 1_000,
    );

    const reclaimed =
      await reclaimExpiredAmuxExecutions({
        now: afterExpiry,
        limit: 20,
      });

    assert.equal(reclaimed, 1);

    const delivery =
      await prisma.amuxWorkDelivery.findUniqueOrThrow({
        where: {
          attemptId: started.attemptId,
        },
      });

    assert.equal(
      delivery.status,
      "cancelled",
    );
    assert.equal(
      delivery.leaseExpiresAt,
      null,
    );
    assert.ok(delivery.cancelledAt);

    const runtime =
      await prisma.amuxWorkerRuntime.findUniqueOrThrow({
        where: {
          workerName: worker,
        },
      });

    assert.equal(
      runtime.instanceId,
      replacementInstance,
    );
    assert.equal(
      runtime.generation,
      replacement.generation,
    );
    assert.equal(runtime.status, "idle");
    assert.equal(
      runtime.dispatchReady,
      true,
    );

    const task =
      await prisma.amuxWorkItem.findUniqueOrThrow({
        where: { id: taskId },
      });

    assert.equal(task.status, "todo");
    assert.equal(task.owner, null);
    assert.equal(task.revision, 3);
  } finally {
    await prisma.amuxWorkDelivery.deleteMany({
      where: { taskId },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: { taskId },
    });

    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });

    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("expired owner reservation is released without deleting its routing evidence while a fresh claim remains owned", async () => {
  const expiredId =
    await createTodo("amux-expired-claim");
  const freshId =
    await createTodo("amux-fresh-claim");

  const expiredWorker =
    `amux-claim-expired-${randomUUID()}`;
  const freshWorker =
    `amux-claim-fresh-${randomUUID()}`;

  const now = new Date(
    "2000-01-02T00:00:00.000Z",
  );

  try {
    const expiredClaim =
      await claimUnownedTodo({
        taskId: expiredId,
        worker: expiredWorker,
        expectedRevision: 0,
        schedulerScore: 32,
        scoringVersion: SCORING_VERSION,
        signals: signals(),
      });

    const freshClaim =
      await claimUnownedTodo({
        taskId: freshId,
        worker: freshWorker,
        expectedRevision: 0,
        schedulerScore: 32,
        scoringVersion: SCORING_VERSION,
        signals: signals(),
      });

    assert.ok(expiredClaim);
    assert.ok(freshClaim);

    const expiredAt = new Date(
      now.getTime() -
        AMUX_CLAIM_RESERVATION_MS -
        1_000,
    );

    await prisma.amuxWorkItem.update({
      where: {
        id: expiredId,
      },
      data: {
        claimedAt: expiredAt,
      },
    });

    await prisma.amuxWorkItem.update({
      where: {
        id: freshId,
      },
      data: {
        claimedAt: new Date(
          now.getTime() - 1_000,
        ),
      },
    });

    const reclaimed =
      await reclaimExpiredAmuxClaims({
        now,
        limit: 20,
      });

    assert.equal(reclaimed, 1);

    const expired =
      await prisma.amuxWorkItem.findUniqueOrThrow({
        where: {
          id: expiredId,
        },
      });

    assert.equal(expired.status, "todo");
    assert.equal(expired.owner, null);
    assert.equal(expired.claimedAt, null);
    assert.equal(expired.revision, 2);

    const fresh =
      await prisma.amuxWorkItem.findUniqueOrThrow({
        where: {
          id: freshId,
        },
      });

    assert.equal(fresh.status, "todo");
    assert.equal(
      fresh.owner,
      freshWorker,
    );
    assert.equal(fresh.revision, 1);
    assert.ok(fresh.claimedAt);

    assert.equal(
      await prisma.amuxRouteDecision.count({
        where: {
          taskId: expiredId,
        },
      }),
      1,
    );

    const audit =
      await prisma.adminAuditLog.findFirst({
        where: {
          action: "amux.claim.expired",
          targetType: "AmuxWorkItem",
          targetId: expiredId,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

    assert.ok(audit);
    assert.equal(audit.actorUserId, null);
    assert.equal(audit.actorEmail, null);
  } finally {
    /*
     * AmuxRouteDecision is append-only evidence. Do not weaken that invariant
     * for cleanup. Park these random-id test rows in a terminal state so they
     * can never become future claim-recovery candidates.
     */
    await prisma.amuxWorkItem.updateMany({
      where: {
        id: {
          in: [expiredId, freshId],
        },
      },
      data: {
        status: "done",
        owner: null,
        claimedAt: null,
      },
    });
  }
});

test("worker cannot advertise idle while its execution is live but may become dispatch-ready after settlement", async () => {
  const taskId =
    await createTodo("amux-idle-boundary");
  const worker =
    `amux-idle-boundary-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: {
        id: taskId,
      },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime =
      await registerAmuxWorkerRuntime(
        worker,
        instanceId,
        base,
      );

    const ready =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId,
        generation: runtime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 500,
        ),
      });

    assert.equal(ready.accepted, true);

    const started =
      await startAmuxExecution({
        taskId,
        worker,
        instanceId,
        generation: runtime.generation,
        expectedRevision: 1,
        now: new Date(
          base.getTime() + 1_000,
        ),
      });

    if (!started.started) {
      throw new Error(
        `execution did not start: ${started.reason}`,
      );
    }

    const prematureIdle =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId,
        generation: runtime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 2_000,
        ),
      });

    assert.equal(
      prematureIdle.accepted,
      false,
    );
    assert.equal(
      prematureIdle.reason,
      "active_execution",
    );

    const stillBusy =
      await prisma.amuxWorkerRuntime.findUniqueOrThrow({
        where: {
          workerName: worker,
        },
      });

    assert.equal(stillBusy.status, "busy");
    assert.equal(
      stillBusy.dispatchReady,
      false,
    );

    const settled =
      await settleAmuxExecution({
        attemptId: started.attemptId,
        worker,
        instanceId,
        generation: runtime.generation,
        taskRevision:
          started.taskRevision,
        outcome: "succeeded",
        toStatus: "done",
        now: new Date(
          base.getTime() + 3_000,
        ),
      });

    assert.equal(settled.settled, true);

    const afterSettlement =
      await prisma.amuxWorkerRuntime.findUniqueOrThrow({
        where: {
          workerName: worker,
        },
      });

    /*
     * Settlement does not invent a terminal/turn boundary.
     * The worker remains busy until it positively reports one.
     */
    assert.equal(
      afterSettlement.status,
      "busy",
    );
    assert.equal(
      afterSettlement.dispatchReady,
      false,
    );

    const idleBoundary =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId,
        generation: runtime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 4_000,
        ),
      });

    assert.equal(
      idleBoundary.accepted,
      true,
    );

    const finalRuntime =
      await prisma.amuxWorkerRuntime.findUniqueOrThrow({
        where: {
          workerName: worker,
        },
      });

    assert.equal(finalRuntime.status, "idle");
    assert.equal(
      finalRuntime.dispatchReady,
      true,
    );
  } finally {
    await prisma.amuxWorkDelivery.deleteMany({
      where: {
        taskId,
      },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: {
        taskId,
      },
    });

    await prisma.amuxWorkerRuntime.deleteMany({
      where: {
        workerName: worker,
      },
    });

    await prisma.amuxWorkItem.deleteMany({
      where: {
        id: taskId,
      },
    });
  }
});

test("server worker scorer independently reproduces routing weights and deterministic selection", async () => {
  const task = {
    task_kind: "feature",
    complexity: 4,
    risk: 1,
    files_expected: null,
  };

  const candidate = (
    workerName: string,
  ) => ({
    worker: {
      worker_name: workerName,
      provider: "codex",
      model: null,
      routing_roles: [
        "feature",
        "implementation",
      ],
      running: true,
      status: "idle",
      dispatch_ready: true,
      archived: false,
      paused: false,
      isolated: false,
      blocked: false,
    },
    predicted_success: 0.8,
    quota_remaining: 0.7,
    expected_speed: 0.6,
    low_rework: 0.9,
    low_human_attention: 0.4,
    cost_efficiency: 0.5,
    provider_exhausted: false,
  });

  const routing = scoreAmuxWorkers(
    task,
    [
      candidate("worker-b"),
      candidate("worker-a"),
    ],
  );

  assert.equal(
    routing.selected_worker,
    "worker-a",
  );

  assert.equal(
    routing.preferred_worker,
    "worker-a",
  );

  assert.equal(
    routing.candidates[0]?.worker_name,
    "worker-a",
  );

  const breakdown =
    routing.candidates[0]?.breakdown;

  assert.ok(breakdown);

  assert.equal(
    breakdown.task_fit.combined,
    1,
  );

  const expected =
    0.30 * 1 +
    0.20 * 0.8 +
    0.20 * 0.7 +
    0.10 * 0.6 +
    0.10 * 0.9 +
    0.05 * 0.4 +
    0.05 * 0.5;

  assert.ok(
    Math.abs(
      breakdown.selected_score -
        expected,
    ) < 1e-12,
  );
});

test("claim API rejects internally consistent client routing evidence when it differs from authoritative server scoring", async () => {
  const taskId =
    await createTodo("amux-authoritative-routing");

  const secret =
    "amux-authoritative-routing-secret-0123456789";

  const previousSecret =
    process.env.TOMVERSE_AMUX_SYNC_SECRET;

  const previousCatalog =
    process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  process.env.TOMVERSE_AMUX_SYNC_SECRET =
    secret;

  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON =
    JSON.stringify([
      {
        worker_name: "a-codex",
        provider: "codex",
        routing_roles: [
          "feature",
          "implementation",
        ],
      },
      {
        worker_name: "b-claude",
        provider: "claude",
        routing_roles: [
          "reasoning",
        ],
      },
    ]);

  try {
    await prisma.amuxWorkItem.update({
      where: {
        id: taskId,
      },
      data: {
        classification: {
          task_kind: "feature",
          complexity: 4,
          risk: 1,
          files_expected: [],
        },
      },
    });

    const snapshot =
      await buildAmuxRoutingSnapshot(
        taskId,
        0,
      );

    assert.equal(snapshot.eligible, true);

    if (!snapshot.eligible) {
      throw new Error(
        "expected authoritative routing snapshot",
      );
    }

    const authoritative =
      scoreAmuxWorkers(
        snapshot.task,
        snapshot.candidates,
      );

    assert.equal(
      authoritative.selected_worker,
      "a-codex",
    );

    const tampered = structuredClone(
      authoritative,
    );

    assert.ok(
      tampered.selected_score !== null,
    );

    tampered.selected_score = 0.99;

    const selectedCandidate =
      tampered.candidates.find(
        (candidate) =>
          candidate.worker_name ===
          tampered.selected_worker,
      );

    assert.ok(selectedCandidate);

    /*
     * Keep client evidence internally self-consistent.
     * The old validator alone would accept this pair.
     */
    selectedCandidate.breakdown.selected_score =
      0.99;

    const response = await claimPost(
      new Request(
        "http://localhost/api/internal/amux/claim",
        {
          method: "POST",
          headers: {
            authorization:
              `Bearer ${secret}`,
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            task_id: taskId,
            worker:
              authoritative.selected_worker,
            expected_revision: 0,
            decision: {
              scheduler_score: 32,
              scoring_version:
                SCORING_VERSION,
              signals: {
                scheduler: {
                  pin: 0,
                  age_hours: 0,
                  type_weight: 12,
                  priority_weight: 20,
                  dependents: 0,
                  dependent_weight: 0,
                  drag: 0,
                },
                routing: {
                  scoring_version:
                    "amux-worker-router-v1",
                  ...tampered,
                },
              },
            },
          }),
        },
      ),
    );

    assert.equal(response.status, 400);

    assert.deepEqual(
      await response.json(),
      {
        error:
          "Routing evidence does not match authoritative server scoring.",
      },
    );

    const task =
      await prisma.amuxWorkItem.findUniqueOrThrow({
        where: {
          id: taskId,
        },
      });

    assert.equal(task.owner, null);
    assert.equal(task.revision, 0);
    assert.equal(task.claimedAt, null);

    assert.equal(
      await prisma.amuxRouteDecision.count({
        where: {
          taskId,
        },
      }),
      0,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env
        .TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET =
        previousSecret;
    }

    if (previousCatalog === undefined) {
      delete process.env
        .TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env
        .TOMVERSE_AMUX_WORKER_CATALOG_JSON =
        previousCatalog;
    }

    await prisma.amuxWorkItem.deleteMany({
      where: {
        id: taskId,
      },
    });
  }
});

test("expired delivery receipt rotates and stale acknowledgements are fenced", async () => {
  const taskId =
    await createTodo("amux-receipt-rotation");

  const worker =
    `amux-receipt-rotation-${randomUUID()}`;

  const instanceId = randomUUID();
  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: {
        id: taskId,
      },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime =
      await registerAmuxWorkerRuntime(
        worker,
        instanceId,
        base,
      );

    const ready =
      await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId,
        generation: runtime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(
          base.getTime() + 500,
        ),
      });

    assert.equal(ready.accepted, true);

    const started =
      await startAmuxExecution({
        taskId,
        worker,
        instanceId,
        generation: runtime.generation,
        expectedRevision: 1,
        now: new Date(
          base.getTime() + 1_000,
        ),
      });

    if (!started.started) {
      throw new Error(
        `execution did not start: ${started.reason}`,
      );
    }

    const first =
      await pullAmuxWorkDelivery({
        worker,
        instanceId,
        generation: runtime.generation,
        now: new Date(
          base.getTime() + 2_000,
        ),
      });

    if (!first.available) {
      throw new Error(
        `first pull unavailable: ${first.reason}`,
      );
    }

    assert.equal(first.available, true);

    const liveRetry =
      await pullAmuxWorkDelivery({
        worker,
        instanceId,
        generation: runtime.generation,
        now: new Date(
          base.getTime() + 3_000,
        ),
      });

    if (!liveRetry.available) {
      throw new Error(
        `live retry unavailable: ${liveRetry.reason}`,
      );
    }

    assert.equal(liveRetry.available, true);

    assert.equal(
      liveRetry.delivery.receiptId,
      first.delivery.receiptId,
    );

    assert.equal(
      liveRetry.delivery.leaseExpiresAt.getTime(),
      first.delivery.leaseExpiresAt.getTime(),
    );

    const expiredAt =
      new Date(
        first.delivery.leaseExpiresAt.getTime() +
          1,
      );

    const expiredAck =
      await acknowledgeAmuxWorkDelivery({
        attemptId:
          first.delivery.attemptId,
        receiptId:
          first.delivery.receiptId,
        worker,
        instanceId,
        generation: runtime.generation,
        taskRevision:
          first.delivery.taskRevision,
        now: expiredAt,
      });

    assert.deepEqual(expiredAck, {
      acknowledged: false,
      reason: "fenced_out",
    });

    const rotated =
      await pullAmuxWorkDelivery({
        worker,
        instanceId,
        generation: runtime.generation,
        now: expiredAt,
      });

    if (!rotated.available) {
      throw new Error(
        `rotated pull unavailable: ${rotated.reason}`,
      );
    }

    assert.equal(rotated.available, true);

    assert.notEqual(
      rotated.delivery.receiptId,
      first.delivery.receiptId,
    );

    const oldReceiptAck =
      await acknowledgeAmuxWorkDelivery({
        attemptId:
          rotated.delivery.attemptId,
        receiptId:
          first.delivery.receiptId,
        worker,
        instanceId,
        generation: runtime.generation,
        taskRevision:
          rotated.delivery.taskRevision,
        now: new Date(
          expiredAt.getTime() + 1,
        ),
      });

    assert.deepEqual(oldReceiptAck, {
      acknowledged: false,
      reason: "fenced_out",
    });

    const currentAck =
      await acknowledgeAmuxWorkDelivery({
        attemptId:
          rotated.delivery.attemptId,
        receiptId:
          rotated.delivery.receiptId,
        worker,
        instanceId,
        generation: runtime.generation,
        taskRevision:
          rotated.delivery.taskRevision,
        now: new Date(
          expiredAt.getTime() + 2,
        ),
      });

    assert.deepEqual(currentAck, {
      acknowledged: true,
      idempotent: false,
    });

    const stored =
      await prisma.amuxWorkDelivery.findUniqueOrThrow({
        where: {
          attemptId: started.attemptId,
        },
      });

    assert.equal(
      stored.receiptId,
      rotated.delivery.receiptId,
    );
    assert.equal(
      stored.status,
      "acknowledged",
    );

    const settled =
      await settleAmuxExecution({
        attemptId: started.attemptId,
        worker,
        instanceId,
        generation: runtime.generation,
        taskRevision:
          started.taskRevision,
        outcome: "succeeded",
        toStatus: "done",
        now: new Date(
          expiredAt.getTime() + 3,
        ),
      });

    assert.equal(settled.settled, true);
  } finally {
    await prisma.amuxWorkDelivery.deleteMany({
      where: {
        taskId,
      },
    });

    await prisma.amuxExecutionAttempt.deleteMany({
      where: {
        taskId,
      },
    });

    await prisma.amuxWorkerRuntime.deleteMany({
      where: {
        workerName: worker,
      },
    });

    await prisma.amuxWorkItem.deleteMany({
      where: {
        id: taskId,
      },
    });
  }
});
