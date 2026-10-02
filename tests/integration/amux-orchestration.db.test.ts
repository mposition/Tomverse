import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { POST as claimPost } from "@/app/api/internal/amux/claim/route";
import { POST as queuePost } from "@/app/api/internal/amux/queue/route";
import { POST as routingSnapshotPost } from "@/app/api/internal/amux/routing-snapshot/route";
import { POST as ownedQueuePost } from "@/app/api/internal/amux/owned-queue/route";
import { POST as workerRegisterPost } from "@/app/api/internal/amux/workers/register/route";
import { POST as workerHeartbeatPost } from "@/app/api/internal/amux/workers/heartbeat/route";
import { POST as executionStartPost } from "@/app/api/internal/amux/execution/start/route";
import { POST as executionHeartbeatPost } from "@/app/api/internal/amux/execution/heartbeat/route";
import { POST as executionSettlePost } from "@/app/api/internal/amux/execution/settle/route";
import { POST as deliveryPullPost } from "@/app/api/internal/amux/delivery/pull/route";
import { POST as deliveryAckPost } from "@/app/api/internal/amux/delivery/ack/route";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { Prisma } from "@prisma/client";
import { Client as PgClient } from "pg";
import { schemaValidAmuxRoutingCandidate } from "../amuxClaimFixture.ts";

import { prisma } from "@/lib/prisma";
import { anchorAmuxClaimDeadline } from "@/lib/amux/claimDeadline";
import {
  AMUX_INCIDENT_SETTING_KEY,
  parseAmuxIncidentSetting,
  serializeAmuxIncidentState,
} from "@/lib/amux/incidentCore";
import {
  AMUX_DB_BOUNDARIES,
  AMUX_DB_COMMIT_RESERVE_MS,
  AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS,
  AmuxDbBoundaryError,
  amuxDbTransactionBudgetMs,
  fenceAmuxRouteDeadline,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  AMUX_COMMIT_DEADLINE_TRIGGER,
  AMUX_LATE_COMMIT_MESSAGE,
  AMUX_LATE_COMMIT_SQLSTATE,
  isAmuxLateCommitError,
} from "@/lib/amux/commitDeadlineCore";
import { readAmuxCommitDeadlineInstallSql } from "../../scripts/amux-commit-deadline-install.mjs";
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
  getRoutingSnapshotTask,
  listDispatchable,
  listOwnedTodos,
  type AmuxDecisionSignals,
} from "@/lib/amux/store";

const SCORING_VERSION = "amux-global-priority-v1";

// The queue bodies the app sends during the compatibility window, the same
// file the Rust client parses (tests/fixtures/amux-queue-wire-compat-v1.json).
const queueWireCompat = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/fixtures/amux-queue-wire-compat-v1.json"),
    "utf8",
  ),
) as {
  queue_server: Record<string, unknown>;
  owned_server: Record<string, unknown>;
};

const makeAmuxSyncSecret = () => `amux-test-${randomUUID()}`;

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

  const schemaName = url.searchParams.get("schema");

  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";

  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");

  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error(
      "REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database",
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

test("AMUX DB statement timeout rolls back the preceding write", async () => {
  const taskId = await createTodo("AMUX-DB-STATEMENT");
  try {
    await assert.rejects(
      withAmuxDbBoundary(
        {
          operation: "statement_timeout_test",
          prismaCallCeiling: 4,
          isolation: "mutation",
        },
        async (tx) => {
          await tx.amuxWorkItem.update({
            where: { id: taskId },
            data: { priority: "p0" },
          });
          await tx.$queryRaw`SELECT pg_sleep(0.35)`;
        },
      ),
    );
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    assert.notEqual(row.priority, "p0");
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("AMUX idle-in-transaction timeout rolls back a preceding write", async () => {
  const taskId = await createTodo("AMUX-DB-IDLE");
  try {
    await assert.rejects(
      withAmuxDbBoundary(
        {
          operation: "idle_timeout_test",
          prismaCallCeiling: 4,
          isolation: "mutation",
        },
        async (tx) => {
          await tx.amuxWorkItem.update({
            where: { id: taskId },
            data: { priority: "p0" },
          });
          await delay(250);
          await tx.$queryRaw`SELECT 1`;
        },
      ),
    );
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    assert.notEqual(row.priority, "p0");
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("AMUX final DB-clock fence rolls back state when its deadline is expired", async () => {
  const taskId = await createTodo("AMUX-DB-FENCE");
  try {
    await assert.rejects(
      withAmuxDbBoundary(
        {
          operation: "expired_fence_test",
          prismaCallCeiling: 5,
          isolation: "mutation",
        },
        async (tx) => {
          await tx.amuxWorkItem.update({
            where: { id: taskId },
            data: { priority: "p0" },
          });
          // Simulate the route's cumulative DB-clock budget being exhausted;
          // the final fence must reject despite each prior SQL completing.
          await tx.$queryRaw`
            SELECT set_config(
              'tomverse.amux_deadline',
              (clock_timestamp() - INTERVAL '1 millisecond')::text,
              true
            )
          `;
        },
      ),
      (error: unknown) =>
        error instanceof AmuxDbBoundaryError &&
        error.code === "AMUX_DB_DEADLINE_EXCEEDED",
    );
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    assert.notEqual(row.priority, "p0");
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("AMUX ownership lease is still live at the final DB-clock fence", async () => {
  const taskId = await createTodo("AMUX-DB-LEASE-FENCE");
  try {
    await assert.rejects(
      withAmuxDbBoundary(
        {
          operation: "expired_lease_fence_test",
          prismaCallCeiling: 3,
          isolation: "mutation",
        },
        async (tx, context) => {
          await tx.amuxWorkItem.update({
            where: { id: taskId },
            data: { priority: "p0" },
          });
          context.requireLeaseAt(new Date(context.dbNow.getTime() - 1));
        },
      ),
      (error: unknown) =>
        error instanceof AmuxDbBoundaryError &&
        error.code === "AMUX_DB_DEADLINE_EXCEEDED",
    );
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    assert.notEqual(row.priority, "p0");
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("AMUX final lease fence keeps UTC instants under a non-UTC DB TimeZone", async () => {
  const sessionZone = await withAmuxDbBoundary(
    {
      operation: "non_utc_lease_fence_test",
      prismaCallCeiling: 5,
      isolation: "read",
    },
    async (tx, context) => {
      const rows = await tx.$queryRaw<Array<{ zone: string }>>`
        SELECT set_config('TimeZone', 'Australia/Brisbane', true) AS zone
      `;
      context.requireLeaseAt(new Date(context.dbNow.getTime() + 60_000));
      return rows[0]?.zone;
    },
  );

  assert.equal(sessionZone, "Australia/Brisbane");
});

test("AMUX DB clock context represents the actual instant in every session TimeZone", async () => {
  const enteredAt = Date.now();
  const clock = await withAmuxDbBoundary(
    {
      operation: "db_clock_instant_test",
      prismaCallCeiling: 3,
      isolation: "read",
    },
    async (tx, context) => {
      const rows = await tx.$queryRaw<
        Array<{ zone: string; dbEpochMs: bigint }>
      >`
        SELECT current_setting('TimeZone') AS zone,
          floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "dbEpochMs"
      `;
      return {
        zone: rows[0]?.zone,
        dbNowMs: context.dbNow.getTime(),
        deadlineAtMs: context.deadlineAt.getTime(),
        dbEpochMs: Number(rows[0]?.dbEpochMs),
      };
    },
  );
  if (process.env.AMUX_EXPECT_DB_TIMEZONE) {
    assert.equal(clock.zone, process.env.AMUX_EXPECT_DB_TIMEZONE);
  }
  assert.ok(Math.abs(clock.dbNowMs - enteredAt) < 5_000);
  assert.ok(Math.abs(clock.dbNowMs - clock.dbEpochMs) < 1_000);
  assert.equal(
    clock.deadlineAtMs - clock.dbNowMs,
    amuxDbTransactionBudgetMs({
      operation: "db_clock_instant_test",
      prismaCallCeiling: 3,
      isolation: "read",
    }),
  );
});

test("an anchored route deadline is not renewed by a later claim transaction", async () => {
  const taskId = await createTodo("AMUX-DB-ABSOLUTE");
  try {
    await withAmuxRouteBudget(async () => {
      await anchorAmuxClaimDeadline();
      await delay(1_050);
      await assert.rejects(
        withAmuxDbBoundary(AMUX_DB_BOUNDARIES.claim, async (tx) => {
          await tx.amuxWorkItem.update({
            where: { id: taskId },
            data: { priority: "p0" },
          });
        }),
        (error: unknown) =>
          error instanceof AmuxDbBoundaryError &&
          error.code === "AMUX_DB_DEADLINE_EXCEEDED",
      );
    }, 1_000);
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    assert.notEqual(row.priority, "p0");
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("AMUX Prisma-call ceiling refuses N+1 before issuing its SQL", async () => {
  await assert.rejects(
    withAmuxDbBoundary(
      { operation: "ceiling_test", prismaCallCeiling: 3, isolation: "read" },
      async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await tx.$queryRaw`SELECT 2`;
        await tx.$queryRaw`SELECT 3`;
      },
    ),
    (error: unknown) =>
      error instanceof AmuxDbBoundaryError &&
      error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
  );
});

test("AMUX LOCAL timeout settings do not leak to another connection use", async () => {
  await withAmuxDbBoundary(
    {
      operation: "local_settings_test",
      prismaCallCeiling: 3,
      isolation: "read",
    },
    async (tx) => {
      const values = await tx.$queryRaw<
        Array<{ statement: string; idle: string }>
      >`
        SELECT current_setting('statement_timeout') AS statement,
          current_setting('idle_in_transaction_session_timeout') AS idle
      `;
      assert.equal(values[0]?.statement, "200ms");
      assert.equal(values[0]?.idle, "100ms");
    },
  );
  const values = await prisma.$queryRaw<
    Array<{ statement: string; idle: string }>
  >`
    SELECT current_setting('statement_timeout') AS statement,
      current_setting('idle_in_transaction_session_timeout') AS idle
  `;
  assert.notEqual(values[0]?.statement, "200ms");
  assert.notEqual(values[0]?.idle, "100ms");
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

test("new AMUX rows default to unowned catalog-only backlog while existing Todo remains runnable", async () => {
  const backlogId = `amux-backlog-default-${randomUUID()}`;
  const todoId = await createTodo("amux-existing-todo");
  const worker = `amux-backlog-worker-${randomUUID()}`;
  const instanceId = randomUUID();

  try {
    const backlog = await prisma.amuxWorkItem.create({
      data: {
        id: backlogId,
        title: "Unapproved catalog card",
      },
    });

    assert.equal(backlog.status, "backlog");
    assert.equal(backlog.owner, null);
    assert.equal(backlog.claimedAt, null);

    const dispatchable = await listDispatchable();
    assert.equal(
      dispatchable.some((task) => task.id === backlogId),
      false,
    );
    assert.equal(
      dispatchable.some((task) => task.id === todoId),
      true,
    );
    assert.equal(await getRoutingSnapshotTask(backlogId, 0), null);
    assert.equal(
      (await listOwnedTodos()).some((task) => task.id === backlogId),
      false,
    );

    const claim = await claimUnownedTodo({
      taskId: backlogId,
      worker,
      expectedRevision: 0,
      schedulerScore: 1,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.deepEqual(claim, { claimed: false, reason: "cas_lost" });

    const base = new Date();
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });
    assert.equal(ready.accepted, true);
    assert.deepEqual(
      await startAmuxExecution({
        taskId: backlogId,
        worker,
        instanceId,
        generation: runtime.generation,
        expectedRevision: 0,
        now: new Date(base.getTime() + 1_000),
      }),
      { started: false, reason: "task_not_startable" },
    );

    const persisted = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: backlogId },
    });
    assert.equal(persisted.status, "backlog");
    assert.equal(persisted.owner, null);
    assert.equal(persisted.revision, 0);
    assert.equal(
      await prisma.amuxRouteDecision.count({ where: { taskId: backlogId } }),
      0,
    );
    assert.equal(
      await prisma.amuxExecutionAttempt.count({ where: { taskId: backlogId } }),
      0,
    );
    assert.equal(
      await prisma.amuxWorkDelivery.count({ where: { taskId: backlogId } }),
      0,
    );
  } finally {
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: { in: [backlogId, todoId] } },
    });
  }
});

test("AMUX backlog is excluded by authenticated queue and routing APIs", async () => {
  const backlogId = `amux-backlog-api-${randomUUID()}`;
  const secret = makeAmuxSyncSecret();
  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";

  try {
    await prisma.amuxWorkItem.create({
      data: { id: backlogId, title: "Catalog card for API isolation" },
    });

    const queueResponse = await queuePost(
      new Request("http://localhost/api/internal/amux/queue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.equal(queueResponse.status, 200);
    const queue = (await queueResponse.json()) as Array<{ id: string }>;
    assert.equal(
      queue.some((task) => task.id === backlogId),
      false,
    );

    const routingResponse = await routingSnapshotPost(
      new Request("http://localhost/api/internal/amux/routing-snapshot", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ task_id: backlogId, expected_revision: 0 }),
      }),
    );
    assert.equal(routingResponse.status, 200);
    assert.deepEqual(await routingResponse.json(), {
      eligible: false,
      execution_ready: false,
      reason: "not_eligible",
      task: null,
      candidates: [],
      telemetry: {},
    });

    const ownedResponse = await ownedQueuePost(
      new Request("http://localhost/api/internal/amux/owned-queue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.equal(ownedResponse.status, 200);
    const owned = (await ownedResponse.json()) as Array<{ id: string }>;
    assert.equal(
      owned.some((task) => task.id === backlogId),
      false,
    );
  } finally {
    if (previousSecret === undefined)
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    if (previousExecutionApi === undefined)
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    else process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
    await prisma.amuxWorkItem.deleteMany({ where: { id: backlogId } });
  }
});

test("catalog-only dependents do not boost Todo priority, but unsatisfied dependencies still block it", async () => {
  const backlogId = `amux-backlog-dependent-${randomUUID()}`;
  const todoId = await createTodo("amux-todo-with-catalog-edge");

  try {
    await prisma.amuxWorkItem.create({
      data: { id: backlogId, title: "Catalog-only dependent" },
    });
    await prisma.amuxWorkDependency.create({
      data: { taskId: backlogId, dependencyId: todoId },
    });

    const queueWithCatalogDependent = await listDispatchable();
    assert.equal(
      queueWithCatalogDependent.find((task) => task.id === todoId)
        ?.dependent_count,
      0,
    );

    await prisma.amuxWorkDependency.deleteMany({
      where: { taskId: backlogId, dependencyId: todoId },
    });
    await prisma.amuxWorkDependency.create({
      data: { taskId: todoId, dependencyId: backlogId },
    });

    // A human-authored dependency is real even when the dependency is catalog-only.
    assert.equal(
      (await listDispatchable()).some((task) => task.id === todoId),
      false,
    );
  } finally {
    await prisma.amuxWorkDependency.deleteMany({
      where: { taskId: { in: [backlogId, todoId] } },
    });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: { in: [backlogId, todoId] } },
    });
  }
});

test("AMUX source identity is complete, unique, and cannot lend backlog ownership", async () => {
  const sourceKey = `WORK-${randomUUID().toUpperCase()}`;
  const ids = [
    `amux-source-valid-${randomUUID()}`,
    `amux-source-duplicate-${randomUUID()}`,
    `amux-source-partial-${randomUUID()}`,
    `amux-source-metadata-${randomUUID()}`,
    `amux-backlog-owner-${randomUUID()}`,
    `amux-source-json-null-${randomUUID()}`,
    `amux-source-digest-${randomUUID()}`,
    `amux-source-case-${randomUUID()}`,
    `amux-source-space-${randomUUID()}`,
    `amux-source-version-space-${randomUUID()}`,
    `amux-source-interior-space-${randomUUID()}`,
    `amux-source-version-tab-${randomUUID()}`,
    `amux-source-digest-case-${randomUUID()}`,
  ];

  try {
    const valid = await prisma.amuxWorkItem.create({
      data: {
        id: ids[0],
        title: "Catalog-only source projection",
        sourceSystem: "workboard",
        sourceKey,
        sourceVersion: "source-commit-test",
        sourceDigest: "a".repeat(64),
        sourceSnapshot: { scope: "synthetic", version: 1 },
      },
    });
    assert.equal(valid.status, "backlog");

    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[1],
          title: "Duplicate source identity",
          sourceSystem: "workboard",
          sourceKey,
          sourceVersion: "source-commit-test",
          sourceDigest: "a".repeat(64),
          sourceSnapshot: { version: 2 },
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[2],
          title: "Half source identity",
          sourceSystem: "workboard",
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[3],
          title: "Incomplete source metadata",
          sourceSystem: "workboard",
          sourceKey: `${sourceKey}-OTHER`,
          sourceVersion: "source-commit-test",
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[4],
          title: "Backlog may not have an owner",
          status: "backlog",
          owner: "worker-a",
          claimedAt: new Date(),
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[5],
          title: "JSON null is not a snapshot",
          sourceSystem: "workboard",
          sourceKey: `${sourceKey}-JSON-NULL`,
          sourceVersion: "source-commit-test",
          sourceDigest: "a".repeat(64),
          sourceSnapshot: Prisma.JsonNull,
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[6],
          title: "Malformed digest",
          sourceSystem: "workboard",
          sourceKey: `${sourceKey}-BAD-DIGEST`,
          sourceVersion: "source-commit-test",
          sourceDigest: "x",
          sourceSnapshot: { version: 1 },
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[7],
          title: "Noncanonical source case",
          sourceSystem: "workboard",
          sourceKey: sourceKey.toLowerCase(),
          sourceVersion: "source-commit-test",
          sourceDigest: "a".repeat(64),
          sourceSnapshot: { version: 1 },
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[8],
          title: "Noncanonical source spacing",
          sourceSystem: "workboard",
          sourceKey: ` ${sourceKey}`,
          sourceVersion: "source-commit-test",
          sourceDigest: "a".repeat(64),
          sourceSnapshot: { version: 1 },
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[9],
          title: "Noncanonical source version spacing",
          sourceSystem: "workboard",
          sourceKey: `${sourceKey}-VERSION-SPACE`,
          sourceVersion: " source-commit-test ",
          sourceDigest: "a".repeat(64),
          sourceSnapshot: { version: 1 },
        },
      }),
    );
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[10],
          title: "Noncanonical source key interior spacing",
          sourceSystem: "workboard",
          sourceKey: `${sourceKey} SPACE`,
          sourceVersion: "source-commit-test",
          sourceDigest: "a".repeat(64),
          sourceSnapshot: { version: 1 },
        },
      }),
    );
    for (const sourceVersion of ["\tsource-commit-test", "source\ncommit"]) {
      await assert.rejects(
        prisma.amuxWorkItem.create({
          data: {
            id: ids[11],
            title: "Control whitespace is not a source version",
            sourceSystem: "workboard",
            sourceKey: `${sourceKey}-VERSION-CONTROL`,
            sourceVersion,
            sourceDigest: "a".repeat(64),
            sourceSnapshot: { version: 1 },
          },
        }),
      );
    }
    await assert.rejects(
      prisma.amuxWorkItem.create({
        data: {
          id: ids[12],
          title: "Uppercase digest is not canonical SHA-256",
          sourceSystem: "workboard",
          sourceKey: `${sourceKey}-DIGEST-CASE`,
          sourceVersion: "source-commit-test",
          sourceDigest: "A".repeat(64),
          sourceSnapshot: { version: 1 },
        },
      }),
    );

    assert.equal(
      await prisma.amuxWorkItem.count({ where: { id: { in: ids } } }),
      1,
    );
  } finally {
    await prisma.amuxWorkItem.deleteMany({ where: { id: { in: ids } } });
  }
});

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

  const winners = [left, right].filter((result) => result.claimed);
  const losers = [left, right].filter((result) => !result.claimed);

  assert.equal(winners.length, 1);
  assert.deepEqual(losers, [{ claimed: false, reason: "cas_lost" }]);

  const task = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: taskId },
  });

  assert.ok(
    task.owner === "amux-db-worker-a" || task.owner === "amux-db-worker-b",
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

  const audits = await prisma.adminAuditLog.findMany({
    where: {
      action: "amux.claim.assigned",
      targetType: "AmuxWorkItem",
      targetId: taskId,
    },
  });

  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.actorUserId, null);
  assert.equal(audits[0]?.actorEmail, null);
  assert.deepEqual(audits[0]?.metadata, {
    decision_id: decisions[0]?.id,
    worker: task.owner,
    prior_task_revision: 0,
    task_revision: 1,
    scheduler_score: 32,
    scoring_version: SCORING_VERSION,
    measured: true,
    verdict: "claimed",
    systemActor: "tomverse-amux-orchestrator",
  });

  const losingWorker =
    task.owner === "amux-db-worker-a" ? "amux-db-worker-b" : "amux-db-worker-a";
  const refusedAudits = await prisma.adminAuditLog.findMany({
    where: {
      action: "amux.claim.refused",
      targetType: "AmuxWorkItem",
      targetId: taskId,
    },
  });

  assert.equal(refusedAudits.length, 1);
  assert.deepEqual(refusedAudits[0]?.metadata, {
    reason: "cas_lost",
    worker: losingWorker,
    expected_revision: 0,
    measured: true,
    verdict: "refused",
    systemActor: "tomverse-amux-orchestrator",
  });

  // Keep historical route evidence append-only, but keep this fixture out of
  // later dispatchable reads.
  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: { status: "done" },
  });
});

test("project WIP admission serializes claims for different tasks", async () => {
  const projectKey = `amux-wip-${randomUUID()}`;
  const firstTaskId = await createTodo("amux-wip-first");
  const secondTaskId = await createTodo("amux-wip-second");

  await Promise.all([
    prisma.amuxWorkItem.update({
      where: { id: firstTaskId },
      data: { projectKey },
    }),
    prisma.amuxWorkItem.update({
      where: { id: secondTaskId },
      data: { projectKey },
    }),
    prisma.amuxResourcePolicy.create({
      data: {
        scope: "project",
        key: projectKey,
        displayName: projectKey,
        wipLimit: 1,
      },
    }),
  ]);

  try {
    const [first, second] = await Promise.all([
      claimUnownedTodo({
        taskId: firstTaskId,
        worker: "amux-wip-worker-a",
        expectedRevision: 0,
        schedulerScore: 32,
        scoringVersion: SCORING_VERSION,
        signals: signals(),
      }),
      claimUnownedTodo({
        taskId: secondTaskId,
        worker: "amux-wip-worker-b",
        expectedRevision: 0,
        schedulerScore: 32,
        scoringVersion: SCORING_VERSION,
        signals: signals(),
      }),
    ]);

    assert.equal([first, second].filter((result) => result.claimed).length, 1);
    assert.deepEqual(
      [first, second].filter((result) => !result.claimed),
      [{ claimed: false, reason: "wip_limit_reached" }],
    );
    const refusedTaskId = first.claimed ? secondTaskId : firstTaskId;
    const refusedWorker = first.claimed
      ? "amux-wip-worker-b"
      : "amux-wip-worker-a";
    const refusalAudit = await prisma.adminAuditLog.findFirstOrThrow({
      where: {
        action: "amux.claim.refused",
        targetType: "AmuxWorkItem",
        targetId: refusedTaskId,
      },
    });
    assert.deepEqual(refusalAudit.metadata, {
      reason: "wip_limit_reached",
      worker: refusedWorker,
      expected_revision: 0,
      measured: true,
      verdict: "refused",
      systemActor: "tomverse-amux-orchestrator",
      // main's refusal evidence (#1595): the full resource and its count.
      blocked_resource: { scope: "project", key: projectKey },
      wip: [{ scope: "project", key: projectKey, limit: 1, current: 1 }],
    });
    assert.equal(
      await prisma.amuxWorkItem.count({
        where: {
          projectKey,
          status: "todo",
          owner: { not: null },
        },
      }),
      1,
    );
  } finally {
    await prisma.amuxWorkItem.updateMany({
      where: { id: { in: [firstTaskId, secondTaskId] } },
      data: { status: "done" },
    });
    await prisma.amuxResourcePolicy.delete({
      where: { scope_key: { scope: "project", key: projectKey } },
    });
  }
});

// Restored from main (#1595). A develop merge dropped these three; they pin the
// execution-start refusal audit under incident mode, the attempt budget and the
// cost guard.
test("incident admission refusals keep claim and execution-start audits atomic", async () => {
  const claimTaskId = await createTodo("amux-incident-claim");
  const startTaskId = await createTodo("amux-incident-start");
  const worker = `amux-incident-worker-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();
  const previousSetting = await prisma.appSetting.findUnique({
    where: { key: AMUX_INCIDENT_SETTING_KEY },
    select: { value: true },
  });

  try {
    await prisma.amuxWorkItem.update({
      where: { id: startTaskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });
    assert.equal(ready.accepted, true);

    await prisma.appSetting.upsert({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      create: {
        key: AMUX_INCIDENT_SETTING_KEY,
        value: serializeAmuxIncidentState({
          version: 1,
          state: "frozen",
          transition_id: null,
          changed_at: base.toISOString(),
          reason: "DB regression incident freeze",
          ticket: "AMUX-DB-INCIDENT",
        }),
      },
      update: {
        value: serializeAmuxIncidentState({
          version: 1,
          state: "frozen",
          transition_id: null,
          changed_at: base.toISOString(),
          reason: "DB regression incident freeze",
          ticket: "AMUX-DB-INCIDENT",
        }),
      },
    });

    const claim = await claimUnownedTodo({
      taskId: claimTaskId,
      worker: `${worker}-claim`,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.deepEqual(claim, {
      claimed: false,
      reason: "incident_admission_blocked",
    });

    const start = await startAmuxExecution({
      taskId: startTaskId,
      worker,
      instanceId,
      generation: runtime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 1_000),
    });
    assert.deepEqual(start, { started: false, reason: "incident_frozen" });

    const [claimAudit, startAudit, claimTask, startTask] = await Promise.all([
      prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "amux.claim.refused", targetId: claimTaskId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.adminAuditLog.findFirstOrThrow({
        where: {
          action: "amux.execution.start_refused",
          targetId: startTaskId,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: claimTaskId } }),
      prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: startTaskId } }),
    ]);
    assert.equal(
      (claimAudit.metadata as Record<string, unknown>).reason,
      "incident_admission_blocked",
    );
    assert.equal(
      (startAudit.metadata as Record<string, unknown>).reason,
      "incident_frozen",
    );
    assert.equal(claimTask.owner, null);
    assert.equal(claimTask.revision, 0);
    assert.equal(startTask.status, "todo");
    assert.equal(startTask.revision, 1);
  } finally {
    if (previousSetting) {
      await prisma.appSetting.update({
        where: { key: AMUX_INCIDENT_SETTING_KEY },
        data: { value: previousSetting.value },
      });
    } else {
      await prisma.appSetting.deleteMany({
        where: { key: AMUX_INCIDENT_SETTING_KEY },
      });
    }
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: { in: [claimTaskId, startTaskId] } },
    });
  }
});

test("execution start blocks a task after five historical attempts without resetting the budget", async () => {
  const taskId = await createTodo("amux-attempt-budget");
  const worker = `amux-attempt-worker-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { owner: worker, claimedAt: base, revision: 1 },
    });
    await prisma.amuxExecutionAttempt.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        id: randomUUID(),
        taskId,
        worker,
        workerInstanceId: instanceId,
        workerGeneration: 1,
        taskRevision: index + 2,
        attemptNumber: index + 1,
        heartbeatAt: base,
        leaseExpiresAt: null,
        startedAt: new Date(base.getTime() - (5 - index) * 1_000),
        endedAt: base,
        outcome: "failed",
        toStatus: "todo",
        endedBy: worker,
        reason: "execution_failed",
      })),
    });
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
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
    assert.deepEqual(started, {
      started: false,
      reason: "attempt_budget_exhausted",
    });

    const [task, attemptCount, escalation] = await Promise.all([
      prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } }),
      prisma.amuxExecutionAttempt.count({ where: { taskId } }),
      prisma.amuxHumanEscalation.findFirstOrThrow({
        where: { taskId, reason: "attempt_budget_exhausted" },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    assert.equal(task.status, "blocked");
    assert.equal(task.revision, 2);
    assert.equal(attemptCount, 5);
    assert.equal(escalation.status, "open");
  } finally {
    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxExecutionAttempt.deleteMany({ where: { taskId } });
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
  }
});

test("execution start blocks before spending when the project cost budget is exhausted", async () => {
  const taskId = await createTodo("amux-start-cost-guard");
  const projectKey = `amux-start-cost-${randomUUID()}`;
  const worker = `amux-start-cost-worker-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();

  try {
    await prisma.amuxResourcePolicy.create({
      data: {
        scope: "project",
        key: projectKey,
        displayName: projectKey,
        costBudgetMicrousd: BigInt(100),
        budgetWindowStartsAt: new Date(base.getTime() - 60_000),
        budgetWindowEndsAt: new Date(base.getTime() + 60_000),
      },
    });
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        projectKey,
        estimatedCostMicrousd: BigInt(101),
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
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
    assert.deepEqual(started, {
      started: false,
      reason: "cost_budget_exhausted",
    });

    const [task, attemptCount, audit] = await Promise.all([
      prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } }),
      prisma.amuxExecutionAttempt.count({ where: { taskId } }),
      prisma.adminAuditLog.findFirstOrThrow({
        where: {
          action: "amux.execution.cost_guard_blocked",
          targetId: taskId,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    assert.equal(task.status, "blocked");
    assert.equal(task.revision, 2);
    assert.equal(attemptCount, 0);
    assert.equal(
      (audit.metadata as Record<string, unknown>).reason,
      "cost_budget_exhausted",
    );
  } finally {
    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
    await prisma.amuxResourcePolicy.deleteMany({
      where: { scope: "project", key: projectKey },
    });
  }
});

test("incident admission refusal is distinct from CAS loss and audited atomically", async () => {
  const taskId = await createTodo("amux-incident-refusal");
  const worker = "amux-incident-worker";
  const previous = await prisma.appSetting.findUnique({
    where: { key: AMUX_INCIDENT_SETTING_KEY },
    select: { value: true },
  });

  await prisma.appSetting.upsert({
    where: { key: AMUX_INCIDENT_SETTING_KEY },
    create: {
      key: AMUX_INCIDENT_SETTING_KEY,
      value: serializeAmuxIncidentState({
        version: 1,
        state: "frozen",
        transition_id: null,
        changed_at: new Date().toISOString(),
        reason: "Integration test incident freeze.",
        ticket: "AMUX-TEST-INCIDENT",
      }),
    },
    update: {
      value: serializeAmuxIncidentState({
        version: 1,
        state: "frozen",
        transition_id: null,
        changed_at: new Date().toISOString(),
        reason: "Integration test incident freeze.",
        ticket: "AMUX-TEST-INCIDENT",
      }),
    },
  });

  try {
    const outcome = await claimUnownedTodo({
      taskId,
      worker,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.deepEqual(outcome, {
      claimed: false,
      reason: "incident_admission_blocked",
    });

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    assert.equal(task.owner, null);
    assert.equal(task.revision, 0);

    const refusalAudit = await prisma.adminAuditLog.findFirstOrThrow({
      where: {
        action: "amux.claim.refused",
        targetType: "AmuxWorkItem",
        targetId: taskId,
      },
    });
    const stored = await prisma.appSetting.findUniqueOrThrow({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      select: { value: true },
    });
    assert.deepEqual(refusalAudit.metadata, {
      reason: "incident_admission_blocked",
      worker,
      expected_revision: 0,
      measured: true,
      verdict: "refused",
      systemActor: "tomverse-amux-orchestrator",
      // main's refusal evidence (#1595): which incident blocked admission.
      incident_state: "frozen",
      incident_transition_id: null,
      incident_valid: parseAmuxIncidentSetting(stored.value).valid,
    });
  } finally {
    if (previous) {
      await prisma.appSetting.update({
        where: { key: AMUX_INCIDENT_SETTING_KEY },
        data: { value: previous.value },
      });
    } else {
      await prisma.appSetting.delete({
        where: { key: AMUX_INCIDENT_SETTING_KEY },
      });
    }
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { status: "done" },
    });
  }
});

test("cost settlement stays attributed to its reservation budget window", async () => {
  const projectKey = `amux-cost-${randomUUID()}`;
  const taskId = await createTodo("amux-cost-window");
  const worker = `amux-cost-worker-${randomUUID()}`;
  const instanceId = randomUUID();
  const base = new Date();
  const windowStartsAt = new Date(base.getTime() - 60_000);
  const windowEndsAt = new Date(base.getTime() + 60_000);

  await prisma.amuxResourcePolicy.create({
    data: {
      scope: "project",
      key: projectKey,
      displayName: projectKey,
      costBudgetMicrousd: BigInt(100),
      budgetWindowStartsAt: windowStartsAt,
      budgetWindowEndsAt: windowEndsAt,
    },
  });
  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: {
      projectKey,
      estimatedCostMicrousd: BigInt(60),
      owner: worker,
      claimedAt: base,
      revision: 1,
    },
  });

  try {
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
    await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 100),
    });
    const started = await startAmuxExecution({
      taskId,
      worker,
      instanceId,
      generation: runtime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 200),
    });
    if (!started.started) {
      assert.fail(`execution did not start: ${started.reason}`);
    }
    const settled = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "done",
      actualCostMicrousd: BigInt(40),
      now: new Date(base.getTime() + 300),
    });
    assert.equal(settled.settled, true);

    const ledger = await prisma.amuxCostLedgerEntry.findMany({
      where: { attemptId: started.attemptId },
      orderBy: { kind: "asc" },
    });
    assert.equal(ledger.length, 2);
    assert.equal(
      ledger.reduce((sum, entry) => sum + entry.amountMicrousd, BigInt(0)),
      BigInt(40),
    );
    for (const entry of ledger) {
      assert.equal(
        entry.budgetWindowStartsAt.getTime(),
        windowStartsAt.getTime(),
      );
      assert.equal(entry.budgetWindowEndsAt.getTime(), windowEndsAt.getTime());
    }
  } finally {
    await prisma.amuxWorkerRuntime.deleteMany({
      where: { workerName: worker },
    });
    await prisma.amuxResourcePolicy.delete({
      where: { scope_key: { scope: "project", key: projectKey } },
    });
  }
});

test("a lost claim response is reconciled by read-back, not a second mutation", async () => {
  const taskId = await createTodo("amux-claim-lost-response");
  const worker = "amux-db-readback-worker";
  try {
    await assert.rejects(async () => {
      const committed = await claimUnownedTodo({
        taskId,
        worker,
        expectedRevision: 0,
        schedulerScore: 32,
        scoringVersion: SCORING_VERSION,
        signals: signals(),
      });
      assert.equal(committed.claimed, true);
      throw new Error("simulated HTTP response loss after DB commit");
    }, /simulated HTTP response loss/);

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });
    const decisions = await prisma.amuxRouteDecision.findMany({
      where: { taskId },
    });
    const audits = await prisma.adminAuditLog.findMany({
      where: {
        action: "amux.claim.assigned",
        targetId: taskId,
      },
    });
    assert.equal(task.owner, worker);
    assert.equal(task.revision, 1);
    assert.equal(decisions.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(
      decisions[0]?.id,
      (audits[0]?.metadata as { decision_id?: string })?.decision_id,
    );
  } finally {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { status: "done" },
    });
  }
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

test("a failed canonical audit insert rolls the owner and route decision back", async () => {
  const taskId = await createTodo("amux-audit-rollback");
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `amux_reject_claim_audit_${suffix}`;
  const triggerName = `amux_reject_claim_audit_t_${suffix}`;

  /*
   * This suite runs only against a disposable dedicated test database and its
   * runner serializes DB suites. A temporary trigger is the integration seam
   * that makes the real canonical audit INSERT fail after the owner CAS and
   * route-decision INSERT have both happened. It is removed in finally even
   * when an assertion fails.
   *
   * Both identifiers contain only the fixed prefix and a dash-free UUID.
   */
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"()
    RETURNS trigger
    SET search_path = pg_catalog, pg_temp
    AS $$
    BEGIN
      IF NEW."action" = 'amux.claim.assigned' THEN
        RAISE EXCEPTION 'AMUX test forced audit failure'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  try {
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "AdminAuditLog"
      FOR EACH ROW
      EXECUTE FUNCTION "${functionName}"()
    `);

    await assert.rejects(
      claimUnownedTodo({
        taskId,
        worker: "amux-db-worker-audit-failure",
        expectedRevision: 0,
        schedulerScore: 32,
        scoringVersion: SCORING_VERSION,
        signals: signals(),
      }),
      /AMUX test forced audit failure/,
    );

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(task.owner, null);
    assert.equal(task.revision, 0);
    assert.equal(task.claimedAt, null);
    assert.equal(
      await prisma.amuxRouteDecision.count({ where: { taskId } }),
      0,
    );
    assert.equal(
      await prisma.adminAuditLog.count({
        where: {
          action: "amux.claim.assigned",
          targetType: "AmuxWorkItem",
          targetId: taskId,
        },
      }),
      0,
    );
  } finally {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER IF EXISTS "${triggerName}" ON "AdminAuditLog"
    `);
    await prisma.$executeRawUnsafe(`
      DROP FUNCTION IF EXISTS "${functionName}"()
    `);
    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
  }
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

  const unblocked = dispatchable.find((task) => task.id === dependentId);

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

  const parent = dispatchable.find((task) => task.id === parentId);

  assert.ok(parent);
  assert.equal(parent.dependent_count, 1);

  // The queue keys an orchestrator built from main before the develop AMUX
  // port requires, kept for the compatibility window.
  assert.deepEqual(
    Object.keys(parent).sort(),
    Object.keys(queueWireCompat.queue_server).sort(),
  );
  assert.equal(parent.status, "todo");
  assert.deepEqual(parent.dependencies, []);

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

  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  try {
    const snapshot = await buildAmuxRoutingSnapshot(taskId, 0);

    assert.deepEqual(snapshot, {
      eligible: false,
      execution_ready: false,
      reason: "worker_catalog_unavailable",
      task: null,
      candidates: [],
      telemetry: {},
    });
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
    }

    await prisma.amuxWorkItem.delete({
      where: { id: taskId },
    });
  }
});

test("routing snapshot rejects worker names outside the response machine-id contract", async () => {
  const taskId = await createTodo("amux-routing-invalid-worker-name");
  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        classification: {
          task_kind: "migration",
          complexity: 8,
          risk: 2,
          files_expected: 2,
        },
      },
    });
    for (const workerName of ["codex-", " codex-a ", "a".repeat(121)]) {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
        {
          worker_name: workerName,
          provider: "codex",
          routing_roles: ["migration"],
        },
      ]);

      assert.deepEqual(await buildAmuxRoutingSnapshot(taskId, 0), {
        eligible: false,
        execution_ready: false,
        reason: "worker_catalog_unavailable",
        task: null,
        candidates: [],
        telemetry: {},
      });
    }
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
    }
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
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

  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

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
    assert.deepEqual(migration.worker.routing_roles, [
      "migration",
      "multi_file",
    ]);

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
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
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

  if (!claim.claimed) {
    assert.fail(`claim was refused: ${claim.reason}`);
  }

  const decision = await prisma.amuxRouteDecision.findUniqueOrThrow({
    where: { id: claim.decisionId },
  });

  assert.equal(decision.worker, worker);
  assert.deepEqual(decision.signals, {
    ...evidence,
    admission: {
      incident: { state: "normal", transition_id: null, valid: true },
      wip: [],
    },
  });

  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: { status: "done" },
  });
});

test("one authenticated claim kill-switch refusal appends one audit without mutating ownership", async () => {
  const taskId = await createTodo("amux-api-kill-switch");
  const secret = makeAmuxSyncSecret();
  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  try {
    const auditCountBefore = await prisma.adminAuditLog.count({
      where: { action: "amux.claim.refused" },
    });

    const response = await claimPost(
      new Request("http://localhost/api/internal/amux/claim", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      claimed: false,
      reason: "execution_api_disabled",
    });

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(task.owner, null);
    assert.equal(task.revision, 0);
    assert.equal(task.claimedAt, null);
    assert.equal(
      await prisma.amuxRouteDecision.count({ where: { taskId } }),
      0,
    );

    const refusalAudits = await prisma.adminAuditLog.findMany({
      where: { action: "amux.claim.refused" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    assert.equal(refusalAudits.length, auditCountBefore + 1);

    const refusalAudit = refusalAudits.at(-1);

    assert.ok(refusalAudit);
    assert.equal(refusalAudit.actorUserId, null);
    assert.equal(refusalAudit.actorEmail, null);
    assert.equal(refusalAudit.targetType, "AmuxClaimRequest");
    assert.equal(refusalAudit.targetId, null);
    assert.deepEqual(refusalAudit.metadata, {
      reason: "execution_api_disabled",
      measured: true,
      verdict: "refused",
      systemActor: "tomverse-amux-orchestrator",
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
    }

    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
  }
});

test("an unauthenticated claim refusal does not append an audit oracle", async () => {
  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = makeAmuxSyncSecret();

  try {
    const auditCountBefore = await prisma.adminAuditLog.count({
      where: { action: "amux.claim.refused" },
    });

    const response = await claimPost(
      new Request("http://localhost/api/internal/amux/claim", {
        method: "POST",
        headers: {
          authorization: "Bearer invalid-amux-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );

    assert.equal(response.status, 401);
    assert.equal(
      await prisma.adminAuditLog.count({
        where: { action: "amux.claim.refused" },
      }),
      auditCountBefore,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }
  }
});

test("an authenticated not-eligible claim appends one bounded refusal audit", async () => {
  const taskId = `amux-missing-${randomUUID()}`;
  const worker = "codex-missing-task";
  const secret = makeAmuxSyncSecret();
  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";

  try {
    const response = await claimPost(
      new Request("http://localhost/api/internal/amux/claim", {
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
            signals: {
              scheduler: signals(),
              routing: {
                scoring_version: "amux-worker-router-v1",
                preferred_worker: null,
                selected_worker: null,
                preferred_score: null,
                selected_score: null,
                candidates: [schemaValidAmuxRoutingCandidate(worker)],
              },
            },
          },
        }),
      }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      claimed: false,
      reason: "not_eligible",
    });

    const audits = await prisma.adminAuditLog.findMany({
      where: {
        action: "amux.claim.refused",
        targetType: "AmuxWorkItem",
        targetId: taskId,
      },
    });

    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.metadata, {
      reason: "not_eligible",
      worker,
      expected_revision: 0,
      measured: true,
      verdict: "refused",
      systemActor: "tomverse-amux-orchestrator",
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
    }
  }
});

test("an authenticated authoritative-worker mismatch appends one bounded refusal audit", async () => {
  const taskId = await createTodo("amux-api-worker-mismatch");
  // Under main's selection rule (#1595) only a running, idle, dispatch-ready
  // worker can be the authoritative choice, so the test registers one; without
  // it the server finds no authoritative worker at all and refuses for that
  // reason instead of the mismatch this test is about.
  const authoritativeWorker = `codex-authoritative-${randomUUID()}`;
  const requestedWorker = "claude-mismatch";
  const secret = makeAmuxSyncSecret();

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

  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";
  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
    {
      worker_name: authoritativeWorker,
      provider: "CODEX",
      routing_roles: ["feature", "implementation"],
    },
  ]);

  try {
    const instanceId = randomUUID();
    const runtime = await registerAmuxWorkerRuntime(authoritativeWorker, instanceId, new Date());
    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: authoritativeWorker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(),
    });
    assert.equal(ready.accepted, true);

    const response = await claimPost(
      new Request("http://localhost/api/internal/amux/claim", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          task_id: taskId,
          worker: requestedWorker,
          expected_revision: 0,
          decision: {
            scheduler_score: 32,
            scoring_version: SCORING_VERSION,
            signals: {
              scheduler: signals(),
              routing: {
                scoring_version: "amux-worker-router-v1",
                preferred_worker: null,
                selected_worker: null,
                preferred_score: null,
                selected_score: null,
                candidates: [schemaValidAmuxRoutingCandidate(requestedWorker)],
              },
            },
          },
        }),
      }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      claimed: false,
      reason: "authoritative_worker_mismatch",
    });

    const audits = await prisma.adminAuditLog.findMany({
      where: {
        action: "amux.claim.refused",
        targetType: "AmuxWorkItem",
        targetId: taskId,
      },
    });

    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.metadata, {
      reason: "authoritative_worker_mismatch",
      worker: requestedWorker,
      expected_revision: 0,
      measured: true,
      verdict: "refused",
      systemActor: "tomverse-amux-orchestrator",
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
    }

    await prisma.amuxWorkerRuntime.deleteMany({ where: { workerName: authoritativeWorker } });
    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
  }
});

// main's selection rule (#1595): a worker that is not running, idle and at a
// dispatch boundary is preferred demand, never a selected owner, so a claim for
// it is refused before any ownership evidence exists.
test("claim API refuses ownership when no worker is execution-ready", async () => {
  const taskId = await createTodo("amux-api-lifecycle-gate");
  const worker = "codex-evidence";
  const secret = makeAmuxSyncSecret();

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

  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";
  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
    {
      worker_name: worker,
      provider: "CODEX",
      routing_roles: ["feature", "implementation"],
    },
  ]);

  try {
    /*
     * An unavailable runtime remains a demand preference, not a selected
     * owner; the claim must refuse before creating any ownership evidence.
     */
    const snapshot = await buildAmuxRoutingSnapshot(taskId, 0);

    assert.equal(snapshot.eligible, true);

    if (!snapshot.eligible) {
      throw new Error("expected authoritative routing snapshot");
    }

    const routing = scoreAmuxWorkers(snapshot.task, snapshot.candidates);

    assert.equal(routing.preferred_worker, worker);
    assert.equal(routing.selected_worker, null);
    assert.equal(snapshot.execution_ready, false);

    const evidence = {
      scheduler: signals(),
      routing: {
        scoring_version: "amux-worker-router-v1",
        ...routing,
      },
    };

    const response = await claimPost(
      new Request("http://localhost/api/internal/amux/claim", {
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
      }),
    );

    const body = await response.json();

    assert.equal(
      response.status,
      409,
      `unexpected response: ${JSON.stringify(body)}`,
    );

    assert.deepEqual(body, {
      claimed: false,
      reason: "no_authoritative_worker",
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

    const refusalAudits = await prisma.adminAuditLog.findMany({
      where: {
        action: "amux.claim.refused",
        targetType: "AmuxWorkItem",
        targetId: taskId,
      },
    });

    assert.equal(refusalAudits.length, 1);
    assert.deepEqual(refusalAudits[0]?.metadata, {
      reason: "no_authoritative_worker",
      worker,
      expected_revision: 0,
      measured: true,
      verdict: "refused",
      systemActor: "tomverse-amux-orchestrator",
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
    }

    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
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

    const afterFirstHeartbeat = await amuxWorkerRuntimeByName([workerName]);

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

    const afterStaleHeartbeat = await amuxWorkerRuntimeByName([workerName]);

    const stillReplacement = afterStaleHeartbeat.get(workerName);

    assert.ok(stillReplacement);
    assert.equal(stillReplacement.instanceId, secondInstance);
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

    const finalRuntime = (await amuxWorkerRuntimeByName([workerName])).get(
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

    const controlAudits = await prisma.adminAuditLog.findMany({
      where: {
        targetType: "AmuxWorkerRuntime",
        targetId: workerName,
        action: {
          in: ["amux.worker.registered", "amux.worker.status_changed"],
        },
      },
    });
    assert.equal(controlAudits.length, 4);
    assert.deepEqual(controlAudits.map((row) => row.action).sort(), [
      "amux.worker.registered",
      "amux.worker.registered",
      "amux.worker.status_changed",
      "amux.worker.status_changed",
    ]);

    const telemetryRefresh = await heartbeatAmuxWorkerRuntime({
      workerName,
      instanceId: secondInstance,
      generation: 2,
      status: "idle",
      dispatchReady: true,
      now: new Date(secondHeartbeatAt.getTime() + 500),
    });
    assert.equal(telemetryRefresh.accepted, true);
    assert.equal(
      await prisma.adminAuditLog.count({
        where: {
          targetType: "AmuxWorkerRuntime",
          targetId: workerName,
          action: "amux.worker.status_changed",
        },
      }),
      2,
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

    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);

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

    const busyRuntime = await prisma.amuxWorkerRuntime.findUniqueOrThrow({
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
    assert.equal(task.owner, null);
    assert.equal(task.claimedAt, null);
    assert.equal(task.revision, 3);

    const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
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
    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

/*
 * Policy version 18, "활성화 증거": a settle whose COMMIT reaches the database
 * after its DB-clock deadline must not be recorded as success. The final fence
 * (`withAmuxDbBoundary`) is a check *before* COMMIT; the tests above prove it
 * rolls back a transaction that is already late when the fence runs. This one
 * makes the fence pass just before the commit deadline D and lets the COMMIT
 * itself arrive after it, which is what a GC pause, a stalled event loop or a
 * slow network between the fence and COMMIT does in production.
 *
 * D is the earliest deadline the settle is held to, less
 * AMUX_DB_COMMIT_RESERVE_MS. Here that is the attempt's lease, set 1.5 s out;
 * the runtime lease (90 s) and the transaction budget are later. The fence
 * records D in `AmuxCommitDeadline` and compares the clock with it; the
 * deferred trigger compares the clock with the same stored D during COMMIT.
 *
 * Instrumentation, at the pg driver the Prisma adapter uses, touches only this
 * settle's connection:
 * - before the fence it walks the open transaction's clock forward with short
 *   pg_sleep statements (each under the 200 ms statement timeout, no idle gap)
 *   until the database clock is FENCE_MARGIN_MS before D -- the same as a
 *   settle whose own work ended there -- and then lets the real fence run;
 * - right after the fence it reads back the marker the fence wrote, which is
 *   how the test knows D and the transaction id without computing either;
 * - it then holds the COMMIT, with no statement in between, until
 *   COMMIT_DELAY_MS after the walk ended, so the COMMIT is sent after D and
 *   while the idle-in-transaction timeout has not fired.
 *
 * The setup assertions keep a pass from being vacuous: the fence let the
 * transaction through with the trigger present, the recorded D is the lease
 * less the reserve, the COMMIT was sent after D, and the idle gap stayed under
 * the idle-in-transaction timeout (so the refusal has to come from something
 * that looks at the deadline, not from that timeout). The refusal is then read
 * on the raw errors, before any mapping: the pg driver's SQLSTATE and the
 * adapter error Prisma rethrows at COMMIT both say AX001.
 */
test("a settle whose COMMIT lands after its commit deadline is refused by the database", async () => {
  const FENCE_MARGIN_MS = 40;
  const COMMIT_DELAY_MS = 70;
  assert.ok(COMMIT_DELAY_MS > FENCE_MARGIN_MS);
  assert.ok(COMMIT_DELAY_MS < AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS);

  const worker = `amux-late-commit-${randomUUID()}`;
  const instanceId = randomUUID();
  const taskId = await createTodo("amux-late-commit");
  const base = new Date();

  type Query = (this: PgClient, ...args: unknown[]) => unknown;
  const prototype = PgClient.prototype as unknown as { query: Query };
  const originalQuery = prototype.query;
  const probe = {
    armed: false,
    client: null as PgClient | null,
    commitDeadlineMs: 0,
    walkEndDbMs: null as number | null,
    walkEndLocalMs: null as number | null,
    fenceWithinDeadline: null as boolean | null,
    fenceCommitCheckInstalled: null as boolean | null,
    markerDeadlineMs: null as number | null,
    markerTxid: null as string | null,
    lastStatementDoneLocalMs: null as number | null,
    commitSentLocalMs: null as number | null,
    commitAccepted: null as boolean | null,
    commitError: null as unknown,
  };
  const textOf = (args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") {
      return (first as { text: string }).text;
    }
    return "";
  };
  const clockMs = async (client: PgClient) => {
    const result = (await originalQuery.call(
      client,
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`,
    )) as { rows: Array<{ nowMs: string }> };
    return Number(result.rows[0]?.nowMs);
  };
  const column = (
    result: { fields?: Array<{ name: string }>; rows?: unknown[][] },
    name: string,
  ) => {
    const index = result.fields?.findIndex((field) => field.name === name) ?? -1;
    return index < 0 ? undefined : result.rows?.[0]?.[index];
  };

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { owner: worker, claimedAt: base, revision: 1 },
    });
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
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

    // The attempt's lease ends 1.5 s from now on the database clock, so the
    // commit deadline is that less the reserve.
    const dbNow = await prisma.$queryRaw<Array<{ nowMs: bigint }>>`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"
    `;
    const leaseDeadlineMs = Number(dbNow[0]?.nowMs) + 1_500;
    probe.commitDeadlineMs = leaseDeadlineMs - AMUX_DB_COMMIT_RESERVE_MS;
    await prisma.amuxExecutionAttempt.update({
      where: { id: started.attemptId },
      data: { leaseExpiresAt: new Date(leaseDeadlineMs) },
    });

    prototype.query = function (this: PgClient, ...args: unknown[]) {
      const text = textOf(args);
      if (probe.armed && probe.client === null && text.includes(`AS "withinDeadline"`)) {
        probe.client = this;
        return (async () => {
          for (;;) {
            const now = await clockMs(this);
            const remaining = probe.commitDeadlineMs - FENCE_MARGIN_MS - now;
            if (remaining <= 0) {
              probe.walkEndDbMs = now;
              probe.walkEndLocalMs = performance.now();
              break;
            }
            await originalQuery.call(this, `SELECT pg_sleep(${(Math.min(remaining, 120) / 1_000).toFixed(3)})`);
          }
          const result = (await originalQuery.apply(this, args)) as {
            fields?: Array<{ name: string }>;
            rows?: unknown[][];
          };
          probe.fenceWithinDeadline = column(result, "withinDeadline") === true;
          probe.fenceCommitCheckInstalled = column(result, "commitCheckInstalled") === true;
          const marker = (await originalQuery.call(
            this,
            `SELECT "txid"::text AS "txid",
               floor(extract(epoch FROM "deadline") * 1000)::bigint::text AS "deadlineMs"
             FROM "AmuxCommitDeadline" WHERE "txid" = txid_current()`,
          )) as { rows: Array<{ txid: string; deadlineMs: string }> };
          probe.markerTxid = marker.rows[0]?.txid ?? null;
          probe.markerDeadlineMs = marker.rows[0] ? Number(marker.rows[0].deadlineMs) : null;
          probe.lastStatementDoneLocalMs = performance.now();
          return result;
        })();
      }
      if (probe.armed && this === probe.client && text.trim().toUpperCase() === "COMMIT") {
        probe.armed = false;
        return (async () => {
          // A timer can wake a fraction of a millisecond before its delay by
          // performance.now(), which failed this setup on CI by under 1 ms.
          // Wait until the target is actually reached.
          const target = (probe.walkEndLocalMs ?? 0) + COMMIT_DELAY_MS;
          for (let wait = target - performance.now(); wait > 0; wait = target - performance.now()) {
            await delay(Math.ceil(wait));
          }
          probe.commitSentLocalMs = performance.now();
          try {
            const result = await originalQuery.apply(this, args);
            probe.commitAccepted = true;
            return result;
          } catch (error) {
            probe.commitAccepted = false;
            probe.commitError = error;
            throw error;
          }
        })();
      }
      return originalQuery.apply(this, args);
    };
    probe.armed = true;

    let settleError: unknown = null;
    try {
      await settleAmuxExecution({
        attemptId: started.attemptId,
        worker,
        instanceId,
        generation: runtime.generation,
        taskRevision: started.taskRevision,
        outcome: "succeeded",
        toStatus: "review",
      });
    } catch (error) {
      settleError = error;
    } finally {
      probe.armed = false;
      prototype.query = originalQuery;
    }

    // Setup: the fence let the transaction through with the trigger present,
    // D is the lease less the reserve, and the COMMIT was sent after D
    // without the idle timeout firing.
    assert.equal(probe.fenceWithinDeadline, true, `setup: the fence must pass (${String(settleError)})`);
    assert.equal(probe.fenceCommitCheckInstalled, true, "setup: the commit deadline trigger must be installed");
    assert.equal(probe.markerDeadlineMs, probe.commitDeadlineMs, "setup: the fence recorded D = lease - reserve");
    assert.ok(probe.markerTxid !== null, "setup: the fence recorded its transaction id");
    assert.ok(
      probe.walkEndDbMs !== null &&
        probe.walkEndDbMs >= probe.commitDeadlineMs - FENCE_MARGIN_MS &&
        probe.walkEndDbMs < probe.commitDeadlineMs,
      "setup: the fence ran a few ms before D",
    );
    assert.ok(
      probe.commitSentLocalMs !== null &&
        probe.walkEndLocalMs !== null &&
        probe.lastStatementDoneLocalMs !== null,
    );
    assert.ok(
      probe.commitSentLocalMs - probe.walkEndLocalMs >= COMMIT_DELAY_MS,
      "setup: the COMMIT must be sent after D",
    );
    assert.ok(
      probe.commitSentLocalMs - probe.lastStatementDoneLocalMs < AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS,
      "setup: the idle gap before COMMIT exceeded the idle-in-transaction timeout; the run proves nothing",
    );

    // The raw errors, before any mapping: the database refused the COMMIT with
    // AX001, and that is the code on the adapter error Prisma rethrew.
    assert.equal(probe.commitAccepted, false, "the late COMMIT was accepted");
    const pgError = probe.commitError as { code?: unknown; message?: unknown };
    assert.equal(pgError.code, AMUX_LATE_COMMIT_SQLSTATE);
    assert.equal(pgError.message, AMUX_LATE_COMMIT_MESSAGE);
    assert.ok(settleError instanceof Error);
    const adapterError = settleError.cause as {
      name?: unknown;
      cause?: { kind?: unknown; code?: unknown };
      meta?: { code?: unknown };
    };
    assert.ok(
      adapterError?.meta?.code === AMUX_LATE_COMMIT_SQLSTATE ||
        (adapterError?.cause?.kind === "postgres" &&
          adapterError.cause.code === AMUX_LATE_COMMIT_SQLSTATE),
      `the error Prisma surfaced at COMMIT does not carry AX001: ${String(adapterError?.name)}`,
    );
    assert.equal(isAmuxLateCommitError(adapterError), true);

    // The mapping, and the verdict: a late COMMIT leaves no success behind.
    assert.ok(settleError instanceof AmuxDbBoundaryError);
    assert.equal(settleError.code, "AMUX_DB_DEADLINE_EXCEEDED");
    const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
      where: { id: started.attemptId },
    });
    const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } });
    assert.notEqual(attempt.outcome, "succeeded");
    assert.notEqual(task.status, "review");
    assert.equal(
      await prisma.amuxCommitDeadline.count({ where: { txid: BigInt(probe.markerTxid) } }),
      0,
      "the refused transaction's marker was rolled back with it",
    );
  } finally {
    prototype.query = originalQuery;
    await prisma.amuxWorkDelivery.deleteMany({ where: { taskId } });
    await prisma.amuxExecutionAttempt.deleteMany({ where: { taskId } });
    await prisma.amuxWorkerRuntime.deleteMany({ where: { workerName: worker } });
    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
  }
});

test("the commit deadline trigger is a deferred constraint trigger on insert, as the migration defines it", async () => {
  const triggers = await prisma.$queryRaw<
    Array<{
      name: string;
      deferrable: boolean;
      initiallyDeferred: boolean;
      enabled: string;
      type: number;
      functionName: string;
      constraintType: string | null;
    }>
  >`
    SELECT t.tgname AS "name",
      t.tgdeferrable AS "deferrable",
      t.tginitdeferred AS "initiallyDeferred",
      t.tgenabled::text AS "enabled",
      t.tgtype::integer AS "type",
      p.proname::text AS "functionName",
      k.contype::text AS "constraintType"
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    LEFT JOIN pg_catalog.pg_constraint k ON k.oid = t.tgconstraint
    WHERE c.oid = to_regclass('"AmuxCommitDeadline"')
      AND NOT t.tgisinternal
  `;
  assert.deepEqual(triggers, [
    {
      name: AMUX_COMMIT_DEADLINE_TRIGGER,
      deferrable: true,
      initiallyDeferred: true,
      enabled: "O",
      // TRIGGER_TYPE_ROW (1) | TRIGGER_TYPE_INSERT (4): AFTER, FOR EACH ROW, on INSERT only.
      type: 5,
      functionName: "amux_commit_deadline_check",
      constraintType: "t",
    },
  ]);
});

test("a COMMIT whose recorded deadline has passed is refused at COMMIT, not at the insert", async () => {
  const taskId = await createTodo("AMUX-COMMIT-DEADLINE-PAST");
  const seen = { txid: null as string | null, insertedLate: false };
  try {
    let commitError: unknown = null;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.amuxWorkItem.update({ where: { id: taskId }, data: { priority: "p0" } });
        const rows = await tx.$queryRaw<Array<{ txid: string; late: boolean }>>`
          INSERT INTO "AmuxCommitDeadline" ("txid", "deadline", "operation")
          VALUES (txid_current(), clock_timestamp() - INTERVAL '1 millisecond', 'commit_deadline_past_test')
          RETURNING "txid"::text AS "txid", clock_timestamp() >= "deadline" AS "late"
        `;
        seen.txid = rows[0]?.txid ?? null;
        seen.insertedLate = rows[0]?.late === true;
      });
    } catch (error) {
      commitError = error;
    }
    // The insert itself was accepted with a deadline already behind it: the
    // check is deferred to COMMIT.
    assert.equal(seen.insertedLate, true);
    assert.ok(seen.txid !== null);
    assert.equal(isAmuxLateCommitError(commitError), true, String(commitError));
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } });
    assert.notEqual(row.priority, "p0", "the refused COMMIT rolled the write back");
    assert.equal(await prisma.amuxCommitDeadline.count({ where: { txid: BigInt(seen.txid) } }), 0);
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("an on-time COMMIT succeeds and leaves no commit deadline row behind", async () => {
  const taskId = await createTodo("AMUX-COMMIT-DEADLINE-ON-TIME");
  try {
    const txid = await withAmuxDbBoundary(
      { operation: "commit_deadline_on_time_test", prismaCallCeiling: 4, isolation: "mutation" },
      async (tx) => {
        await tx.amuxWorkItem.update({ where: { id: taskId }, data: { priority: "p0" } });
        const rows = await tx.$queryRaw<Array<{ txid: string }>>`SELECT txid_current()::text AS "txid"`;
        return rows[0]?.txid ?? null;
      },
    );
    assert.ok(txid !== null);
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(row.priority, "p0");
    assert.equal(await prisma.amuxCommitDeadline.count({ where: { txid: BigInt(txid) } }), 0);
    assert.equal(await prisma.amuxCommitDeadline.count(), 0);
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("a transaction rolled back for another reason leaves no commit deadline row", async () => {
  const taskId = await createTodo("AMUX-COMMIT-DEADLINE-ROLLBACK");
  try {
    // The mutation fence inserts its marker and refuses in the same statement.
    const seen = {
      refusedTxid: null as string | null,
      thrownTxid: null as string | null,
      markerSeen: false,
    };
    await assert.rejects(
      withAmuxDbBoundary(
        { operation: "commit_deadline_refused_test", prismaCallCeiling: 5, isolation: "mutation" },
        async (tx) => {
          await tx.amuxWorkItem.update({ where: { id: taskId }, data: { priority: "p0" } });
          const rows = await tx.$queryRaw<Array<{ txid: string }>>`SELECT txid_current()::text AS "txid"`;
          seen.refusedTxid = rows[0]?.txid ?? null;
          await tx.$queryRaw`
            SELECT set_config(
              'tomverse.amux_deadline',
              (clock_timestamp() - INTERVAL '1 millisecond')::text,
              true
            )
          `;
        },
      ),
      (error: unknown) =>
        error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_DEADLINE_EXCEEDED",
    );
    assert.ok(seen.refusedTxid !== null);
    assert.equal(await prisma.amuxCommitDeadline.count({ where: { txid: BigInt(seen.refusedTxid) } }), 0);

    // The route fence passes and writes its marker; the transaction then
    // fails on something else and takes the marker with it.
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await fenceAmuxRouteDeadline(tx, new Date(Date.now() + 60_000), "commit_deadline_rollback_test");
        const rows = await tx.$queryRaw<Array<{ txid: string; present: boolean }>>`
          SELECT txid_current()::text AS "txid",
            EXISTS (SELECT 1 FROM "AmuxCommitDeadline" WHERE "txid" = txid_current()) AS "present"
        `;
        seen.thrownTxid = rows[0]?.txid ?? null;
        seen.markerSeen = rows[0]?.present === true;
        throw new Error("rolled back for another reason");
      }),
      /rolled back for another reason/,
    );
    assert.equal(seen.markerSeen, true);
    assert.ok(seen.thrownTxid !== null);
    assert.equal(await prisma.amuxCommitDeadline.count({ where: { txid: BigInt(seen.thrownTxid) } }), 0);
    assert.equal(await prisma.amuxCommitDeadline.count(), 0);
    const row = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } });
    assert.notEqual(row.priority, "p0");
  } finally {
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

/*
 * Nothing here is committed. The trigger is dropped, the fence is run, and the
 * installer is exercised inside one transaction that the test rolls back, so
 * a run that dies half way leaves the migrated trigger in place for every test
 * after it (migrate deploy would not put it back). The route fence runs on
 * that transaction's own client; its trigger check is the same clause as the
 * mutation fence's (tests/amuxCommitDeadline.test.mjs), and what
 * withAmuxDbBoundary does with the refusal is covered through the real Prisma
 * client in tests/server-contract/amux-commit-deadline-boundary.test.ts.
 */
test("without the commit deadline trigger the fence refuses, and the installer restores the migration's definition, all rolled back", async () => {
  const install = readAmuxCommitDeadlineInstallSql(process.cwd());
  type CheckState = { count: number; deferred: boolean; body: string | null };
  const checkState = async (client: Pick<typeof prisma, "$queryRaw">): Promise<CheckState> => {
    const rows = await client.$queryRaw<CheckState[]>`
      SELECT count(t.oid)::integer AS "count",
        coalesce(
          bool_and(
            t.tgdeferrable AND t.tginitdeferred AND t.tgtype::integer = 5
              AND t.tgfoid = to_regprocedure('"amux_commit_deadline_check"()')
          ),
          false
        ) AS "deferred",
        (
          SELECT p.prosrc FROM pg_catalog.pg_proc p
          WHERE p.oid = to_regprocedure('"amux_commit_deadline_check"()')
        ) AS "body"
      FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = to_regclass('"AmuxCommitDeadline"')
        AND t.tgname = 'amux_commit_deadline_check'
    `;
    const row = rows[0];
    assert.ok(row);
    return row;
  };
  const migrated = (state: CheckState) =>
    state.count === 1 && state.deferred && (state.body ?? "").includes("'AX001'");

  assert.equal(migrated(await checkState(prisma)), true, "setup: the migration installed the check");
  const ROLL_BACK = new Error("roll the catalogue changes back");
  const seen = {
    missingRefusal: null as unknown,
    dropped: null as CheckState | null,
    installedOnce: null as CheckState | null,
    installedTwice: null as CheckState | null,
    stale: null as CheckState | null,
    refreshed: null as CheckState | null,
    fencePassedAfterRestore: false,
  };
  const warnings = mock.method(console, "warn", () => {});
  try {
    await assert.rejects(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`DROP TRIGGER "amux_commit_deadline_check" ON "AmuxCommitDeadline"`;
          seen.dropped = await checkState(tx);

          // The fence refuses without the trigger. Its marker insert is undone
          // at the savepoint so the transaction can fence again below.
          await tx.$executeRaw`SAVEPOINT commit_check_missing`;
          try {
            await fenceAmuxRouteDeadline(tx, new Date(Date.now() + 60_000), "commit_deadline_missing_test");
          } catch (error) {
            seen.missingRefusal = error;
          }
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT commit_check_missing`;

          // The push harnesses' installer puts it back; a second run changes nothing.
          await tx.$executeRawUnsafe(install);
          seen.installedOnce = await checkState(tx);
          await tx.$executeRawUnsafe(install);
          seen.installedTwice = await checkState(tx);

          // An older function body and a trigger that is not deferred are both
          // replaced with the migration's.
          await tx.$executeRaw`DROP TRIGGER "amux_commit_deadline_check" ON "AmuxCommitDeadline"`;
          await tx.$executeRaw`
            CREATE OR REPLACE FUNCTION "amux_commit_deadline_check"()
            RETURNS TRIGGER LANGUAGE plpgsql AS $stale$ BEGIN RETURN NULL; END; $stale$
          `;
          await tx.$executeRaw`
            CREATE CONSTRAINT TRIGGER "amux_commit_deadline_check"
              AFTER INSERT ON "AmuxCommitDeadline"
              DEFERRABLE INITIALLY IMMEDIATE
              FOR EACH ROW EXECUTE FUNCTION "amux_commit_deadline_check"()
          `;
          seen.stale = await checkState(tx);
          await tx.$executeRawUnsafe(install);
          seen.refreshed = await checkState(tx);

          // With the definition restored the same fence passes.
          await fenceAmuxRouteDeadline(tx, new Date(Date.now() + 60_000), "commit_deadline_restored_test");
          seen.fencePassedAfterRestore = true;
          throw ROLL_BACK;
        },
        { timeout: 15_000 },
      ),
      (error: unknown) => error === ROLL_BACK,
    );
  } finally {
    warnings.mock.restore();
  }

  assert.ok(seen.dropped && seen.dropped.count === 0, JSON.stringify(seen.dropped));
  assert.ok(seen.missingRefusal instanceof AmuxDbBoundaryError);
  assert.equal(seen.missingRefusal.code, "AMUX_DB_COMMIT_CHECK_MISSING");
  assert.equal(warnings.mock.callCount(), 1);
  assert.ok(seen.installedOnce && migrated(seen.installedOnce), JSON.stringify(seen.installedOnce));
  assert.deepEqual(seen.installedTwice, seen.installedOnce);
  assert.ok(seen.stale && seen.stale.count === 1 && !seen.stale.deferred, JSON.stringify(seen.stale));
  assert.equal((seen.stale.body ?? "").includes("AX001"), false);
  assert.ok(seen.refreshed && migrated(seen.refreshed), JSON.stringify(seen.refreshed));
  assert.equal(seen.fencePassedAfterRestore, true);

  // The rollback left the migrated check exactly as it was, and it still works.
  assert.equal(migrated(await checkState(prisma)), true);
  assert.equal(await prisma.amuxCommitDeadline.count(), 0);
  const committed = await withAmuxDbBoundary(
    { operation: "commit_deadline_intact_test", prismaCallCeiling: 2, isolation: "mutation" },
    async () => "committed",
  );
  assert.equal(committed, "committed");
  assert.equal(await prisma.amuxCommitDeadline.count(), 0);
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

    assert.equal(replacement.generation, firstRuntime.generation + 1);

    const staleHeartbeat = await heartbeatAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId: firstInstance,
      generation: firstRuntime.generation,
      taskRevision: started.taskRevision,
      now: new Date(base.getTime() + 3_000),
    });

    assert.equal(staleHeartbeat, false);
    assert.equal(
      await prisma.adminAuditLog.count({
        where: {
          action: "amux.execution.lease_renewed",
          targetType: "AmuxWorkItem",
          targetId: taskId,
        },
      }),
      0,
    );

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

    const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
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
    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("execution API is fail-closed by default and preserves the execution fences when enabled", async () => {
  const taskId = await createTodo("amux-execution-api");
  const worker = `amux-api-${randomUUID()}`;
  const instanceId = randomUUID();
  const secret = makeAmuxSyncSecret();
  const base = new Date();

  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

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

    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);

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
      new Request("http://localhost/api/internal/amux/execution/start", {
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
      }),
    );

    assert.equal(disabledResponse.status, 409);

    assert.deepEqual(await disabledResponse.json(), {
      started: false,
      reason: "execution_api_disabled",
    });

    const untouched = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(untouched.status, "todo");
    assert.equal(untouched.revision, 1);

    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";

    const startResponse = await executionStartPost(
      new Request("http://localhost/api/internal/amux/execution/start", {
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
      }),
    );

    assert.equal(startResponse.status, 200);

    const startBody = (await startResponse.json()) as {
      started: true;
      attempt_id: string;
      task_revision: number;
    };

    assert.equal(startBody.started, true);
    assert.equal(startBody.task_revision, 2);

    const heartbeatResponse = await executionHeartbeatPost(
      new Request("http://localhost/api/internal/amux/execution/heartbeat", {
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
          task_revision: startBody.task_revision,
        }),
      }),
    );

    assert.equal(heartbeatResponse.status, 200);
    assert.deepEqual(await heartbeatResponse.json(), {
      accepted: true,
    });

    const settleResponse = await executionSettlePost(
      new Request("http://localhost/api/internal/amux/execution/settle", {
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
          task_revision: startBody.task_revision,
          outcome: "succeeded",
          to_status: "review",
        }),
      }),
    );

    assert.equal(settleResponse.status, 200);

    assert.deepEqual(await settleResponse.json(), {
      settled: true,
      taskRevision: 3,
    });
    const settledReviewTask = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true, owner: true, claimedAt: true },
    });
    assert.equal(settledReviewTask.status, "review");
    assert.equal(settledReviewTask.owner, null);
    assert.equal(settledReviewTask.claimedAt, null);

    const actions = await prisma.adminAuditLog.findMany({
      where: {
        targetType: "AmuxWorkItem",
        targetId: taskId,
        action: {
          in: [
            "amux.execution.started",
            "amux.execution.lease_renewed",
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
        "amux.execution.lease_renewed",
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
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
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

    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
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

    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);

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

    const afterExpiry = new Date(started.leaseExpiresAt.getTime() + 1_000);

    const reclaimed = await reclaimExpiredAmuxExecutions({
      now: afterExpiry,
      limit: 20,
    });

    assert.equal(reclaimed, 1);

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: { id: taskId },
    });

    assert.equal(task.status, "todo");
    assert.equal(task.owner, null);
    assert.equal(task.claimedAt, null);
    assert.equal(task.revision, 3);

    const attempt = await prisma.amuxExecutionAttempt.findUniqueOrThrow({
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

    const audit = await prisma.adminAuditLog.findFirst({
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

    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("execution-off worker and owned routes cannot touch control state", async () => {
  const worker = `amux-gated-${randomUUID()}`;
  const secret = makeAmuxSyncSecret();
  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
  try {
    const auditBefore = await prisma.adminAuditLog.count({
      where: { targetType: "AmuxWorkerRuntime", targetId: worker },
    });
    const routes = [
      ["workers/register", workerRegisterPost],
      ["workers/heartbeat", workerHeartbeatPost],
      ["owned-queue", ownedQueuePost],
    ] as const;
    for (const [path, POST] of routes) {
      const response = await POST(
        new Request(`http://localhost/api/internal/amux/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}` },
          body: "{malformed body must not be parsed}",
        }),
      );
      assert.equal(response.status, 409, path);
      assert.equal((await response.json()).reason, "execution_api_disabled");
    }
    assert.equal(
      await prisma.amuxWorkerRuntime.count({ where: { workerName: worker } }),
      0,
    );
    assert.equal(
      await prisma.adminAuditLog.count({
        where: { targetType: "AmuxWorkerRuntime", targetId: worker },
      }),
      auditBefore,
    );
  } finally {
    if (previousSecret === undefined)
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    if (previousExecutionApi === undefined)
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    else process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
  }
});

// The owned queue keeps the seven keys a WSL bridge built from main before the
// develop AMUX port requires, during the compatibility window; that bridge
// halts on a body without them (docs/ops/amux/wsl-execution-bridge.md, "Wire
// compatibility"). description and claimed_at are Options there and are not
// sent. The key list is the shared fixture the Rust client parses.
test("owned queue exposes only runnable owner-assigned Todo work in the compatibility shape", async () => {
  const ownedId = await createTodo("amux-owned-queue");
  const unownedId = await createTodo("amux-unowned-queue");
  const worker = `amux-owned-${randomUUID()}`;
  const secret = makeAmuxSyncSecret();
  const claimedAt = new Date();

  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";

  try {
    await prisma.amuxWorkItem.update({
      where: {
        id: ownedId,
      },
      data: {
        owner: worker,
        claimedAt,
        description: "Delivery body for the selected worker.",
        kind: "code",
        priority: "p1",
        revision: 4,
      },
    });

    const response = await ownedQueuePost(
      new Request("http://localhost/api/internal/amux/owned-queue", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );

    assert.equal(response.status, 200);

    const rows = (await response.json()) as Array<{
      id: string;
      title: string;
      kind: string;
      priority: string;
      owner: string;
      revision: number;
      created_at: string;
    }>;

    const owned = rows.find((row) => row.id === ownedId);

    assert.ok(owned);
    assert.equal(owned.owner, worker);
    assert.equal(owned.revision, 4);
    assert.equal(owned.kind, "code");
    assert.equal(owned.priority, "p1");
    // The stored description never reaches the wire.
    assert.doesNotMatch(
      JSON.stringify(rows),
      /Delivery body for the selected worker/,
    );
    assert.deepEqual(
      Object.keys(owned).sort(),
      Object.keys(queueWireCompat.owned_server).sort(),
    );

    assert.equal(
      rows.some((row) => row.id === unownedId),
      false,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }
    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
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

  const secret = ["amux", "delivery", "integration", "test", "secret"].join(
    "-",
  );

  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";

  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: {
        owner: worker,
        claimedAt: base,
        revision: 1,
      },
    });

    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);

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

    /*
     * started=true now guarantees that the execution attempt and exactly one
     * queued durable delivery committed in the same transaction.
     */
    const atomicDelivery = await prisma.amuxWorkDelivery.findUniqueOrThrow({
      where: {
        attemptId: started.attemptId,
      },
    });

    assert.equal(atomicDelivery.taskId, taskId);
    assert.equal(atomicDelivery.worker, worker);
    assert.equal(atomicDelivery.workerInstanceId, instanceId);
    assert.equal(atomicDelivery.workerGeneration, runtime.generation);
    assert.equal(atomicDelivery.taskRevision, started.taskRevision);
    assert.equal(atomicDelivery.status, "queued");
    assert.equal(atomicDelivery.receiptId, null);

    assert.ok(atomicDelivery.prompt.includes(`Task: ${taskId}`));
    assert.ok(
      atomicDelivery.prompt.includes(`Execution attempt: ${started.attemptId}`),
    );
    assert.ok(
      atomicDelivery.prompt.includes(`Task revision: ${started.taskRevision}`),
    );

    const prompt = atomicDelivery.prompt;

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
        new Request("http://localhost/api/internal/amux/delivery/pull", {
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
        }),
      );

    const firstPull = await pullRequest();

    assert.equal(firstPull.status, 200);

    const firstPullBody = (await firstPull.json()) as {
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

    assert.equal(firstPullBody.available, true);
    assert.equal(firstPullBody.delivery.attempt_id, started.attemptId);
    assert.equal(firstPullBody.delivery.task_id, taskId);
    assert.equal(firstPullBody.delivery.task_revision, started.taskRevision);
    assert.equal(firstPullBody.delivery.prompt, prompt);

    const secondPull = await pullRequest();

    assert.equal(secondPull.status, 200);

    const secondPullBody = (await secondPull.json()) as typeof firstPullBody;

    assert.equal(
      secondPullBody.delivery.receipt_id,
      firstPullBody.delivery.receipt_id,
    );

    const wrongAck = await deliveryAckPost(
      new Request("http://localhost/api/internal/amux/delivery/ack", {
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
          task_revision: started.taskRevision,
        }),
      }),
    );

    assert.equal(wrongAck.status, 409);

    const ackRequest = () =>
      deliveryAckPost(
        new Request("http://localhost/api/internal/amux/delivery/ack", {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            attempt_id: started.attemptId,
            receipt_id: firstPullBody.delivery.receipt_id,
            worker,
            instance_id: instanceId,
            generation: runtime.generation,
            task_revision: started.taskRevision,
          }),
        }),
      );

    const firstAck = await ackRequest();

    assert.equal(firstAck.status, 200);

    assert.deepEqual(await firstAck.json(), {
      acknowledged: true,
      idempotent: false,
    });

    const secondAck = await ackRequest();

    assert.equal(secondAck.status, 200);

    assert.deepEqual(await secondAck.json(), {
      acknowledged: true,
      idempotent: true,
    });

    const delivery = await prisma.amuxWorkDelivery.findUniqueOrThrow({
      where: {
        attemptId: started.attemptId,
      },
    });

    assert.equal(delivery.status, "acknowledged");
    assert.equal(delivery.receiptId, firstPullBody.delivery.receipt_id);
    assert.equal(delivery.leaseExpiresAt, null);
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
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
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

    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("replacement runtime cannot consume an old delivery and expiry cancels it without changing the replacement generation", async () => {
  const taskId = await createTodo("amux-delivery-replacement");

  const worker = `amux-delivery-replacement-${randomUUID()}`;

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

    const queued = await prisma.amuxWorkDelivery.findUniqueOrThrow({
      where: {
        attemptId: started.attemptId,
      },
    });

    assert.equal(queued.status, "queued");
    assert.equal(queued.workerInstanceId, firstInstance);
    assert.equal(queued.workerGeneration, firstRuntime.generation);
    assert.equal(queued.taskRevision, started.taskRevision);

    const replacement = await registerAmuxWorkerRuntime(
      worker,
      replacementInstance,
      new Date(base.getTime() + 2_000),
    );

    assert.equal(replacement.generation, firstRuntime.generation + 1);

    const replacementReady = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId: replacementInstance,
      generation: replacement.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 2_500),
    });

    assert.equal(replacementReady.accepted, true);

    const replacementPull = await pullAmuxWorkDelivery({
      worker,
      instanceId: replacementInstance,
      generation: replacement.generation,
      now: new Date(base.getTime() + 3_000),
    });

    assert.deepEqual(replacementPull, {
      available: false,
      reason: "runtime_not_ready",
    });

    const afterExpiry = new Date(started.leaseExpiresAt.getTime() + 1_000);

    const reclaimed = await reclaimExpiredAmuxExecutions({
      now: afterExpiry,
      limit: 20,
    });

    assert.equal(reclaimed, 1);

    const delivery = await prisma.amuxWorkDelivery.findUniqueOrThrow({
      where: {
        attemptId: started.attemptId,
      },
    });

    assert.equal(delivery.status, "cancelled");
    assert.equal(delivery.leaseExpiresAt, null);
    assert.ok(delivery.cancelledAt);

    const runtime = await prisma.amuxWorkerRuntime.findUniqueOrThrow({
      where: {
        workerName: worker,
      },
    });

    assert.equal(runtime.instanceId, replacementInstance);
    assert.equal(runtime.generation, replacement.generation);
    assert.equal(runtime.status, "idle");
    assert.equal(runtime.dispatchReady, true);

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
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

    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.deleteMany({
      where: { id: taskId },
    });
  }
});

test("expired owner reservation is released without deleting its routing evidence while a fresh claim remains owned", async () => {
  const expiredId = await createTodo("amux-expired-claim");
  const freshId = await createTodo("amux-fresh-claim");

  const expiredWorker = `amux-claim-expired-${randomUUID()}`;
  const freshWorker = `amux-claim-fresh-${randomUUID()}`;

  const now = new Date("2000-01-02T00:00:00.000Z");

  try {
    const expiredClaim = await claimUnownedTodo({
      taskId: expiredId,
      worker: expiredWorker,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });

    const freshClaim = await claimUnownedTodo({
      taskId: freshId,
      worker: freshWorker,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });

    assert.equal(expiredClaim.claimed, true);
    assert.equal(freshClaim.claimed, true);

    const expiredAt = new Date(
      now.getTime() - AMUX_CLAIM_RESERVATION_MS - 1_000,
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
        claimedAt: new Date(now.getTime() - 1_000),
      },
    });

    const reclaimed = await reclaimExpiredAmuxClaims({
      now,
      limit: 20,
    });

    assert.equal(reclaimed, 1);

    const expired = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: {
        id: expiredId,
      },
    });

    assert.equal(expired.status, "todo");
    assert.equal(expired.owner, null);
    assert.equal(expired.claimedAt, null);
    assert.equal(expired.revision, 2);

    const fresh = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: {
        id: freshId,
      },
    });

    assert.equal(fresh.status, "todo");
    assert.equal(fresh.owner, freshWorker);
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

    const audit = await prisma.adminAuditLog.findFirst({
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
  const taskId = await createTodo("amux-idle-boundary");
  const worker = `amux-idle-boundary-${randomUUID()}`;
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

    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);

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

    const prematureIdle = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 2_000),
    });

    assert.equal(prematureIdle.accepted, false);
    assert.equal(prematureIdle.reason, "active_execution");

    const stillBusy = await prisma.amuxWorkerRuntime.findUniqueOrThrow({
      where: {
        workerName: worker,
      },
    });

    assert.equal(stillBusy.status, "busy");
    assert.equal(stillBusy.dispatchReady, false);

    const settled = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "done",
      now: new Date(base.getTime() + 3_000),
    });

    assert.equal(settled.settled, true);

    const afterSettlement = await prisma.amuxWorkerRuntime.findUniqueOrThrow({
      where: {
        workerName: worker,
      },
    });

    /*
     * Settlement does not invent a terminal/turn boundary.
     * The worker remains busy until it positively reports one.
     */
    assert.equal(afterSettlement.status, "busy");
    assert.equal(afterSettlement.dispatchReady, false);

    const idleBoundary = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 4_000),
    });

    assert.equal(idleBoundary.accepted, true);

    const finalRuntime = await prisma.amuxWorkerRuntime.findUniqueOrThrow({
      where: {
        workerName: worker,
      },
    });

    assert.equal(finalRuntime.status, "idle");
    assert.equal(finalRuntime.dispatchReady, true);
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

  const candidate = (workerName: string) => ({
    worker: {
      worker_name: workerName,
      provider: "codex",
      model: null,
      routing_roles: ["feature", "implementation"],
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

  const routing = scoreAmuxWorkers(task, [
    candidate("worker-b"),
    candidate("worker-a"),
  ]);

  assert.equal(routing.selected_worker, "worker-a");

  assert.equal(routing.preferred_worker, "worker-a");

  assert.equal(routing.candidates[0]?.worker_name, "worker-a");

  const breakdown = routing.candidates[0]?.breakdown;

  assert.ok(breakdown);

  assert.equal(breakdown.task_fit.combined, 1);

  const expected =
    0.3 * 1 +
    0.2 * 0.8 +
    0.2 * 0.7 +
    0.1 * 0.6 +
    0.1 * 0.9 +
    0.05 * 0.4 +
    0.05 * 0.5;

  assert.ok(Math.abs(breakdown.selected_score - expected) < 1e-12);
});

test("claim API persists authoritative routing when consistent client evidence drifts", async () => {
  const taskId = await createTodo("amux-authoritative-routing");

  const secret = "amux-authoritative-routing-secret-0123456789";

  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;

  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;

  const previousExecutionApi = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;

  const worker = `a-codex-${randomUUID()}`;

  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;

  process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";

  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
    {
      worker_name: worker,
      provider: "codex",
      routing_roles: ["feature", "implementation"],
    },
    {
      worker_name: "b-claude",
      provider: "claude",
      routing_roles: ["reasoning"],
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

    const instanceId = randomUUID();
    const base = new Date();
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
    const ready = await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 100),
    });
    assert.equal(ready.accepted, true);

    const snapshot = await buildAmuxRoutingSnapshot(taskId, 0);

    assert.equal(snapshot.eligible, true);

    if (!snapshot.eligible) {
      throw new Error("expected authoritative routing snapshot");
    }

    const authoritative = scoreAmuxWorkers(snapshot.task, snapshot.candidates);

    assert.equal(authoritative.selected_worker, worker);

    const tampered = structuredClone(authoritative);

    assert.ok(tampered.selected_score !== null);

    tampered.selected_score = 0.99;

    const selectedCandidate = tampered.candidates.find(
      (candidate) => candidate.worker_name === tampered.selected_worker,
    );

    assert.ok(selectedCandidate);

    /*
     * Keep client evidence internally self-consistent while changing a
     * time-dependent score. The server persists its own claim-time result.
     */
    selectedCandidate.breakdown.selected_score = 0.99;

    const response = await claimPost(
      new Request("http://localhost/api/internal/amux/claim", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          task_id: taskId,
          worker: authoritative.selected_worker,
          expected_revision: 0,
          decision: {
            scheduler_score: 32,
            scoring_version: SCORING_VERSION,
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
                scoring_version: "amux-worker-router-v1",
                ...tampered,
              },
            },
          },
        }),
      }),
    );

    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.claimed, true);

    const task = await prisma.amuxWorkItem.findUniqueOrThrow({
      where: {
        id: taskId,
      },
    });

    assert.equal(task.owner, worker);
    assert.equal(task.revision, 1);
    const decision = await prisma.amuxRouteDecision.findFirstOrThrow({
      where: { taskId },
    });
    assert.equal(decision.worker, worker);
    assert.equal(
      (decision.signals as { routing: { selected_score: number } }).routing
        .selected_score,
      authoritative.selected_score,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    } else {
      process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
    }

    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
    }
    if (previousExecutionApi === undefined) {
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    } else {
      process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = previousExecutionApi;
    }
    // The successful claim created an append-only route decision. Keep its
    // task in this disposable test database rather than deleting evidence.
  }
});

test("expired delivery receipt rotates and stale acknowledgements are fenced", async () => {
  const taskId = await createTodo("amux-receipt-rotation");

  const worker = `amux-receipt-rotation-${randomUUID()}`;

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

    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);

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

    const first = await pullAmuxWorkDelivery({
      worker,
      instanceId,
      generation: runtime.generation,
      now: new Date(base.getTime() + 2_000),
    });

    if (!first.available) {
      throw new Error(`first pull unavailable: ${first.reason}`);
    }

    assert.equal(first.available, true);

    const liveRetry = await pullAmuxWorkDelivery({
      worker,
      instanceId,
      generation: runtime.generation,
      now: new Date(base.getTime() + 3_000),
    });

    if (!liveRetry.available) {
      throw new Error(`live retry unavailable: ${liveRetry.reason}`);
    }

    assert.equal(liveRetry.available, true);

    assert.equal(liveRetry.delivery.receiptId, first.delivery.receiptId);

    assert.equal(
      liveRetry.delivery.leaseExpiresAt.getTime(),
      first.delivery.leaseExpiresAt.getTime(),
    );

    const expiredAt = new Date(first.delivery.leaseExpiresAt.getTime() + 1);

    const expiredAck = await acknowledgeAmuxWorkDelivery({
      attemptId: first.delivery.attemptId,
      receiptId: first.delivery.receiptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: first.delivery.taskRevision,
      now: expiredAt,
    });

    assert.deepEqual(expiredAck, {
      acknowledged: false,
      reason: "fenced_out",
    });

    const rotated = await pullAmuxWorkDelivery({
      worker,
      instanceId,
      generation: runtime.generation,
      now: expiredAt,
    });

    if (!rotated.available) {
      throw new Error(`rotated pull unavailable: ${rotated.reason}`);
    }

    assert.equal(rotated.available, true);

    assert.notEqual(rotated.delivery.receiptId, first.delivery.receiptId);

    const receiptAudits = await prisma.adminAuditLog.findMany({
      where: {
        action: "amux.delivery.receipt_issued",
        targetType: "AmuxWorkItem",
        targetId: taskId,
      },
    });
    assert.equal(receiptAudits.length, 2);
    assert.deepEqual(
      new Set(
        receiptAudits.map(
          (row) => (row.metadata as { receipt_id: string }).receipt_id,
        ),
      ),
      new Set([first.delivery.receiptId, rotated.delivery.receiptId]),
    );

    const oldReceiptAck = await acknowledgeAmuxWorkDelivery({
      attemptId: rotated.delivery.attemptId,
      receiptId: first.delivery.receiptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: rotated.delivery.taskRevision,
      now: new Date(expiredAt.getTime() + 1),
    });

    assert.deepEqual(oldReceiptAck, {
      acknowledged: false,
      reason: "fenced_out",
    });

    const currentAck = await acknowledgeAmuxWorkDelivery({
      attemptId: rotated.delivery.attemptId,
      receiptId: rotated.delivery.receiptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: rotated.delivery.taskRevision,
      now: new Date(expiredAt.getTime() + 2),
    });

    assert.deepEqual(currentAck, {
      acknowledged: true,
      idempotent: false,
    });

    const stored = await prisma.amuxWorkDelivery.findUniqueOrThrow({
      where: {
        attemptId: started.attemptId,
      },
    });

    assert.equal(stored.receiptId, rotated.delivery.receiptId);
    assert.equal(stored.status, "acknowledged");

    const settled = await settleAmuxExecution({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      outcome: "succeeded",
      toStatus: "done",
      now: new Date(expiredAt.getTime() + 3),
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

test("the admin card list reads attempt counts and the latest attempt in set queries", async () => {
  // Source checks cannot see a raw-SQL parameter the driver refuses; this runs
  // the query against PostgreSQL through the same Prisma adapter as production.
  const { listAmuxCardsForAdmin } = await import("@/lib/amux/adminCardList");
  const taskId = await createTodo("amux-admin-card-list");
  const base = new Date();
  try {
    await prisma.amuxExecutionAttempt.createMany({
      data: [
        { outcome: "failed", toStatus: "todo", offset: 2_000 },
        { outcome: "blocked", toStatus: "blocked", offset: 1_000 },
      ].map((attempt, index) => ({
        id: randomUUID(),
        taskId,
        worker: "claude-impl",
        workerInstanceId: randomUUID(),
        workerGeneration: 1,
        taskRevision: index + 1,
        attemptNumber: index + 1,
        heartbeatAt: base,
        leaseExpiresAt: null,
        startedAt: new Date(base.getTime() - attempt.offset),
        endedAt: base,
        outcome: attempt.outcome,
        toStatus: attempt.toStatus,
        endedBy: "claude-impl",
        reason: "execution_failed",
      })),
    });
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { drag: 0 },
    });

    const list = await listAmuxCardsForAdmin();
    const row = list.rows.find((candidate) => candidate.id === taskId);
    assert.ok(row, "the freshly updated card is within the newest rows");
    assert.equal(row.attemptCount, 2);
    assert.equal(row.lastAttemptOutcome, "blocked");
    assert.equal(row.lastAttemptToStatus, "blocked");
    assert.equal(row.briefPresent, false);
    assert.ok(list.total >= list.rows.length);
  } finally {
    await prisma.amuxExecutionAttempt.deleteMany({ where: { taskId } });
    await prisma.amuxWorkItem.delete({ where: { id: taskId } });
  }
});

test("the admin board requires matching claim evidence before showing assigned Todo", async () => {
  const { listAmuxCardsForAdmin } = await import("@/lib/amux/adminCardList");
  const taskId = await createTodo("amux-admin-claim-evidence");
  const worker = `amux-claim-evidence-${randomUUID()}`;
  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { owner: worker },
    });
    const ownerOnly = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(ownerOnly);
    assert.equal(ownerOnly.claimVerified, false);

    await prisma.$transaction(async (tx) => {
      await tx.amuxWorkItem.update({
        where: { id: taskId },
        data: { claimedAt: new Date(), revision: 1 },
      });
      await tx.amuxRouteDecision.create({
        data: {
          taskId,
          worker,
          schedulerScore: 1,
          scoringVersion: "synthetic-admin-claim-test",
          taskRevision: 0,
          signals: {},
        },
      });
    });
    const claimed = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(claimed);
    assert.equal(claimed.claimVerified, true);

    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { revision: 2 },
    });
    const stale = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(stale);
    assert.equal(stale.claimVerified, false);
  } finally {
    // Route decisions are append-only evidence; leave this synthetic card
    // terminal rather than weakening the database invariant for cleanup.
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { status: "done", owner: null, claimedAt: null },
    });
  }
});

test("the admin board distinguishes review obligation from open escalation", async () => {
  const { listAmuxCardsForAdmin } = await import("@/lib/amux/adminCardList");
  const taskId = await createTodo("amux-admin-escalation");
  const escalationId = randomUUID();
  try {
    await prisma.amuxWorkItem.update({
      where: { id: taskId },
      data: { status: "review", requiresHumanReview: true, reviewSpecialty: "code-review" },
    });
    const review = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(review);
    assert.equal(review.requiresHumanReview, true);
    assert.equal(review.hasOpenEscalation, false);

    await prisma.amuxHumanEscalation.create({
      data: { id: escalationId, taskId, reason: "synthetic_review_needed", openedBy: "synthetic-test" },
    });
    const escalated = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(escalated);
    assert.equal(escalated.hasOpenEscalation, true);

    await prisma.amuxHumanEscalation.update({
      where: { id: escalationId },
      data: {
        status: "acknowledged",
        acknowledgedAt: new Date(),
        acknowledgedById: "synthetic-test",
      },
    });
    const acknowledged = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(acknowledged);
    assert.equal(acknowledged.hasOpenEscalation, true);

    await prisma.amuxHumanEscalation.update({
      where: { id: escalationId },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedById: "synthetic-test",
        resolution: "synthetic_resolved",
        resolutionOutcome: "approve",
      },
    });
    const resolved = (await listAmuxCardsForAdmin()).rows.find((row) => row.id === taskId);
    assert.ok(resolved);
    assert.equal(resolved.hasOpenEscalation, false);
  } finally {
    await prisma.amuxWorkItem.update({ where: { id: taskId }, data: { status: "done" } });
  }
});

const runPromotedCardToSettle = async (
  label: string,
  settle: (input: {
    attemptId: string;
    worker: string;
    instanceId: string;
    generation: number;
    taskRevision: number;
    now: Date;
  }) => Promise<unknown>,
) => {
  const { boardPromotionExecutionBriefDigest } = await import("@/lib/amux/boardPromotionCore");
  const worker = `amux-review-${randomUUID()}`;
  const instanceId = randomUUID();
  const taskId = await createTodo(label);
  const base = new Date();
  const brief = "Approved brief for the human review regression.";
  await prisma.amuxWorkItem.update({
    where: { id: taskId },
    data: {
      owner: worker,
      claimedAt: base,
      revision: 1,
      executionBrief: brief,
      executionBriefDigest: boardPromotionExecutionBriefDigest(brief),
    },
  });
  const cleanup = async () => {
    await prisma.amuxHumanEscalation.deleteMany({ where: { taskId } });
    await prisma.amuxWorkDelivery.deleteMany({ where: { taskId } });
    await prisma.amuxExecutionAttempt.deleteMany({ where: { taskId } });
    await prisma.amuxWorkerRuntime.deleteMany({ where: { workerName: worker } });
    await prisma.amuxWorkItem.deleteMany({ where: { id: taskId } });
  };
  try {
    const runtime = await registerAmuxWorkerRuntime(worker, instanceId, base);
    await heartbeatAmuxWorkerRuntime({
      workerName: worker,
      instanceId,
      generation: runtime.generation,
      status: "idle",
      dispatchReady: true,
      now: new Date(base.getTime() + 500),
    });
    const started = await startAmuxExecution({
      taskId,
      worker,
      instanceId,
      generation: runtime.generation,
      expectedRevision: 1,
      now: new Date(base.getTime() + 1_000),
    });
    if (!started.started) throw new Error(`execution did not start: ${started.reason}`);
    const result = await settle({
      attemptId: started.attemptId,
      worker,
      instanceId,
      generation: runtime.generation,
      taskRevision: started.taskRevision,
      now: new Date(base.getTime() + 2_000),
    });
    const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } });
    const escalations = await prisma.amuxHumanEscalation.findMany({ where: { taskId } });
    return { result, task, escalations, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

test("a promoted card that asks for done goes to human review with an escalation", async () => {
  const { result, task, escalations, cleanup } = await runPromotedCardToSettle(
    "amux-review-forced",
    (input) => settleAmuxExecution({ ...input, outcome: "succeeded", toStatus: "done" }),
  );
  try {
    assert.deepEqual(result, { settled: true, taskRevision: 3 });
    assert.equal(task.status, "review");
    assert.equal(task.owner, null);
    assert.equal(task.reviewPrNumber, null);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].reason, "human_review_required");
  } finally {
    await cleanup();
  }
});

test("a review settlement records the named PR on the card in the same transaction", async () => {
  const { result, task, escalations, cleanup } = await runPromotedCardToSettle(
    "amux-review-pr",
    (input) =>
      settleAmuxExecution({ ...input, outcome: "succeeded", toStatus: "review", reviewPrNumber: 1733 }),
  );
  try {
    assert.deepEqual(result, { settled: true, taskRevision: 3 });
    assert.equal(task.status, "review");
    assert.equal(task.reviewPrNumber, 1733);
    // AmuxWorkItem_review_pr_check requires the flag with a stored PR.
    assert.equal(task.requiresHumanReview, true);
    // AmuxWorkItem_human_review_shape_check pairs the flag with a specialty.
    assert.equal(task.reviewSpecialty, "code-review");
    assert.equal(escalations.length, 1);
  } finally {
    await cleanup();
  }
});

test("a review settlement that names no PR clears a PR left by an earlier attempt", async () => {
  const { result, task, cleanup } = await runPromotedCardToSettle("amux-review-pr-cleared", async (input) => {
    await prisma.amuxWorkItem.update({
      where: { id: (await prisma.amuxExecutionAttempt.findUniqueOrThrow({ where: { id: input.attemptId } })).taskId },
      data: { requiresHumanReview: true, reviewSpecialty: "code-review", reviewPrNumber: 1600 },
    });
    return settleAmuxExecution({ ...input, outcome: "succeeded", toStatus: "review", reviewPrNumber: null });
  });
  try {
    assert.deepEqual(result, { settled: true, taskRevision: 3 });
    assert.equal(task.status, "review");
    assert.equal(task.reviewPrNumber, null);
  } finally {
    await cleanup();
  }
});

test("a runner reason code is kept on the attempt and on the blocked escalation", async () => {
  const { task, escalations, cleanup } = await runPromotedCardToSettle("amux-review-unlinked", (input) =>
    settleAmuxExecution({ ...input, outcome: "blocked", toStatus: "blocked", reason: "local_card_unlinked" }),
  );
  try {
    assert.equal(task.status, "blocked");
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].reason, "local_card_unlinked");
    const attempt = await prisma.amuxExecutionAttempt.findFirstOrThrow({ where: { taskId: task.id } });
    assert.equal(attempt.reason, "local_card_unlinked");
  } finally {
    await cleanup();
  }
});

test("a PR number on any settlement other than succeeded to review is refused before the transaction", async () => {
  await assert.rejects(
    settleAmuxExecution({
      attemptId: randomUUID(),
      worker: "amux-review-refused",
      instanceId: randomUUID(),
      generation: 1,
      taskRevision: 1,
      outcome: "failed",
      toStatus: "todo",
      reviewPrNumber: 7,
    }),
    /Invalid AMUX review PR number/,
  );
});

test("a worker that already owns an open card is not claimed a second one", async () => {
  const worker = `amux-one-at-a-time-${randomUUID()}`;
  const first = await createTodo("amux-one-first");
  const second = await createTodo("amux-one-second");
  try {
    const claimed = await claimUnownedTodo({
      taskId: first,
      worker,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.equal(claimed.claimed, true);

    const refused = await claimUnownedTodo({
      taskId: second,
      worker,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.deepEqual(refused, { claimed: false, reason: "execution_lifecycle_unavailable" });
    const untouched = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: second } });
    assert.equal(untouched.owner, null);
    assert.equal(untouched.revision, 0);
    assert.equal(await prisma.amuxRouteDecision.count({ where: { taskId: second } }), 0);

    // Once the first card leaves todo/doing the worker can take the next one.
    await prisma.amuxWorkItem.update({ where: { id: first }, data: { status: "done" } });
    const next = await claimUnownedTodo({
      taskId: second,
      worker,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.equal(next.claimed, true);
  } finally {
    // Route decisions are append-only evidence; keep the fixtures out of later
    // dispatchable reads the same way the other claim tests do.
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: [first, second] } }, data: { status: "done" } });
  }
});

test("routing does not offer a worker that already owns an open card", async () => {
  const busy = `amux-route-busy-${randomUUID()}`;
  const free = `amux-route-free-${randomUUID()}`;
  const owned = await createTodo("amux-route-owned");
  const next = await createTodo("amux-route-next");
  const previousCatalog = process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
    { worker_name: busy, provider: "codex", routing_roles: ["implementation"] },
    { worker_name: free, provider: "codex", routing_roles: ["implementation"] },
  ]);
  try {
    await prisma.amuxWorkItem.update({
      where: { id: next },
      data: {
        classification: { task_kind: "implementation", complexity: 3, risk: 1 },
      },
    });
    for (const worker of [busy, free]) {
      const instanceId = randomUUID();
      const runtime = await registerAmuxWorkerRuntime(worker, instanceId, new Date());
      const ready = await heartbeatAmuxWorkerRuntime({
        workerName: worker,
        instanceId,
        generation: runtime.generation,
        status: "idle",
        dispatchReady: true,
        now: new Date(),
      });
      assert.equal(ready.accepted, true);
    }
    const claimed = await claimUnownedTodo({
      taskId: owned,
      worker: busy,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.equal(claimed.claimed, true);

    const snapshot = await buildAmuxRoutingSnapshot(next, 0);
    if (!snapshot.eligible) assert.fail("expected an eligible routing snapshot");
    const readiness = Object.fromEntries(
      snapshot.candidates.map((candidate) => [
        candidate.worker.worker_name,
        candidate.worker.dispatch_ready,
      ]),
    );
    assert.deepEqual(readiness, { [busy]: false, [free]: true });
    assert.equal(snapshot.execution_ready, true);
  } finally {
    if (previousCatalog === undefined) {
      delete process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON;
    } else {
      process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = previousCatalog;
    }
    await prisma.amuxWorkerRuntime.deleteMany({ where: { workerName: { in: [busy, free] } } });
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: [owned, next] } }, data: { status: "done" } });
  }
});

test("a claim under both project and team WIP policies fits the claim call ceiling", async () => {
  const projectKey = `amux-ceiling-project-${randomUUID()}`;
  const teamKey = `amux-ceiling-team-${randomUUID()}`;
  const taskId = await createTodo("amux-ceiling");
  await Promise.all([
    prisma.amuxWorkItem.update({ where: { id: taskId }, data: { projectKey, teamKey } }),
    prisma.amuxResourcePolicy.create({
      data: { scope: "project", key: projectKey, displayName: projectKey, wipLimit: 5 },
    }),
    prisma.amuxResourcePolicy.create({
      data: { scope: "team", key: teamKey, displayName: teamKey, wipLimit: 5 },
    }),
  ]);
  try {
    const claimed = await claimUnownedTodo({
      taskId,
      worker: `amux-ceiling-worker-${randomUUID()}`,
      expectedRevision: 0,
      schedulerScore: 32,
      scoringVersion: SCORING_VERSION,
      signals: signals(),
    });
    assert.equal(claimed.claimed, true);
  } finally {
    await prisma.amuxWorkItem.updateMany({ where: { id: taskId }, data: { status: "done" } });
    await prisma.amuxResourcePolicy.deleteMany({
      where: {
        OR: [
          { scope: "project", key: projectKey },
          { scope: "team", key: teamKey },
        ],
      },
    });
  }
});
