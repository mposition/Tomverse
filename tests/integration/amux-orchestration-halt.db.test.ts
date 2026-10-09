import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Session } from "next-auth";

import { POST as claimPost } from "@/app/api/internal/amux/claim/route";
import { POST as recoverPost } from "@/app/api/internal/amux/execution/recover/route";
import { POST as ackPost } from "@/app/api/internal/amux/orchestrator/ack/route";
import {
  GET as haltStateGet,
  POST as haltRecordPost,
} from "@/app/api/internal/amux/orchestrator/halt/route";
import { prisma } from "@/lib/prisma";
import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  admitAmuxOrchestratorWrite,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  clearAmuxOrchestratorHalt,
  insertAmuxOrchestratorAdmission,
  lockAmuxOrchestratorAdmission,
  resolveAmuxOrchestratorWriteLocked,
} from "@/lib/amux/orchestratorHaltStore";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";
import { scoreAmuxWorkers } from "@/lib/amux/workerRouterCore";
import {
  heartbeatAmuxWorkerRuntime,
  registerAmuxWorkerRuntime,
} from "@/lib/amux/workerRuntime";

// Orchestration policy version 20 ("orchestrator 정지(halt)와 재시작")
// against PostgreSQL, through the migration history
// (20260930120000_amux_orchestrator_halt), in the routing lane of Credit
// Finance DB Integration.
//
// Each test names the "완료 조건" bullet it covers. The orchestrator's own
// side (known answers, waiting states, startup, the in-memory halt) is
// covered by the Rust tests in apps/tomverse-orchestrator/src.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
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
};
requireDedicatedAmuxTestDatabase();

after(async () => {
  await prisma.$disconnect();
});

const GRACE_MS = 5_000;

/**
 * A database refusal, found wherever Prisma put the trigger's message: the
 * error text, its meta or its cause. A pattern of null accepts any refusal.
 */
const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp | null = null) => {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, "the database accepted what it must refuse");
  if (pattern === null) return;
  const record = caught as { meta?: unknown; cause?: unknown };
  const text = [String(caught), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" ");
  assert.match(text, pattern);
};

const withEnv = async <T>(values: Record<string, string | undefined>, work: () => Promise<T>) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const secret = `amux-halt-test-${randomUUID()}`;
const bearer = { authorization: `Bearer ${secret}` };
const identityHeaders = (requestId: string, instanceId = randomUUID()) => ({
  "x-amux-request-id": requestId,
  "x-amux-instance-id": instanceId,
});

const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer, ...headers },
    body: JSON.stringify(body),
  });

const createTodo = async (prefix: string) => {
  const id = `${prefix}-${randomUUID()}`;
  await prisma.amuxWorkItem.create({
    data: {
      id,
      title: `AMUX halt regression ${id}`,
      status: "todo",
      kind: "code",
      priority: "p1",
      pinned: false,
      drag: 0,
      classification: { task_kind: "feature", complexity: 4, risk: 1, files_expected: [] },
    },
  });
  return id;
};

/** An admission written straight through the store, with its own budget. */
const admit = async (budgetMs: number, callKind: "claim" | "recover" | "auto_promotion_tick" = "claim") => {
  const requestId = randomUUID();
  const instanceId = randomUUID();
  const result = await prisma.$transaction((tx) =>
    insertAmuxOrchestratorAdmission(tx, { requestId, instanceId, callKind, budgetMs }),
  );
  assert.equal(result.admitted, true);
  return { requestId, instanceId };
};

const writeRow = (requestId: string) =>
  prisma.amuxOrchestratorWrite.findUniqueOrThrow({ where: { requestId } });

const receiptsOf = (requestId: string) =>
  prisma.amuxOrchestratorWriteReceipt.findMany({ where: { requestId }, orderBy: { targetKind: "asc" } });

const dbNow = async () =>
  (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`)[0]!.now;

/** Sets up one claimable card and one execution-ready worker, and the evidence a claim carries. */
const claimableCard = async (prefix: string) => {
  const taskId = await createTodo(prefix);
  const worker = `halt-${randomUUID().slice(0, 8)}`;
  const catalog = JSON.stringify([
    { worker_name: worker, provider: "codex", routing_roles: ["feature", "implementation"] },
  ]);
  return withEnv({ TOMVERSE_AMUX_WORKER_CATALOG_JSON: catalog }, async () => {
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
    if (!snapshot.eligible) throw new Error("expected an eligible snapshot");
    const routing = scoreAmuxWorkers(snapshot.task, snapshot.candidates);
    assert.equal(routing.selected_worker, worker);
    return {
      taskId,
      worker,
      catalog,
      body: {
        task_id: taskId,
        worker,
        expected_revision: 0,
        decision: {
          scheduler_score: 32,
          scoring_version: "amux-global-priority-v1",
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
            routing: { scoring_version: "amux-worker-router-v1", ...routing },
          },
        },
      },
    };
  });
};

const ownerSession = (): Session =>
  ({
    user: { id: `owner-${randomUUID()}`, email: "owner@example.test" },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as Session;

const adminRequest = () =>
  new Request("http://localhost/api/admin/amux/orchestrator-halts", {
    method: "POST",
    headers: { "user-agent": "amux-halt-db-test" },
  });

/** Opens a halt through the internal route, as the orchestrator does. */
const recordHalt = async (body: Record<string, unknown>) => {
  const response = await haltRecordPost(post("/api/internal/amux/orchestrator/halt", {}, body));
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json as { halt_id: string; halt_key: string; created: boolean; cleared: boolean };
};

const readState = async (haltKeys: string[] = []) => {
  const query = haltKeys.map((key) => `halt_key=${key}`).join("&");
  const response = await haltStateGet(
    new Request(`http://localhost/api/internal/amux/orchestrator/halt${query ? `?${query}` : ""}`, {
      headers: bearer,
    }),
  );
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json as {
    open_halts: Array<{ halt_id: string }>;
    human_required: Array<{ request_id: string; call_kind: string; receipt_count: number }>;
    halts: Array<{ halt_key: string; halt_id: string; cleared: boolean }>;
  };
};

test("an admission commits on its own before the write, with deadlineAt on the database clock plus the route budget", async () => {
  // 완료 조건: 접수가 쓰기보다 먼저 별도 트랜잭션으로 커밋된다; deadlineAt은 접수
  // 트랜잭션의 clock_timestamp() 기준.
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret, TOMVERSE_AMUX_EXECUTION_API_ENABLED: undefined }, async () => {
    const requestId = randomUUID();
    const before = await dbNow();
    const response = await recoverPost(post("/api/internal/amux/execution/recover", identityHeaders(requestId)));
    const after_ = await dbNow();
    assert.equal(response.status, 409);
    const row = await writeRow(requestId);
    assert.equal(row.callKind, "recover");
    assert.ok(row.admittedAt.getTime() >= before.getTime() - 1 && row.admittedAt.getTime() <= after_.getTime() + 1);
    assert.equal(row.deadlineAt.getTime() - row.admittedAt.getTime(), 12_000);
    assert.equal(row.ackedAt, null);
    assert.equal(row.resolvedAt, null);
  });

  // The trigger re-anchors a writer's own clock on the database's.
  const requestId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "AmuxOrchestratorWrite" ("requestId", "instanceId", "callKind", "admittedAt", "deadlineAt")
    VALUES (${requestId}, ${randomUUID()}, 'claim', '2001-01-01T00:00:00Z'::timestamptz, '2001-01-01T00:00:12Z'::timestamptz)
  `;
  const row = await writeRow(requestId);
  assert.ok(Math.abs(row.admittedAt.getTime() - (await dbNow()).getTime()) < 5_000);
  assert.equal(row.deadlineAt.getTime() - row.admittedAt.getTime(), 12_000);
  // And refuses a budget over sixty seconds.
  await rejectsWith(
    prisma.$executeRaw`
      INSERT INTO "AmuxOrchestratorWrite" ("requestId", "instanceId", "callKind", "admittedAt", "deadlineAt")
      VALUES (${randomUUID()}, ${randomUUID()}, 'claim', clock_timestamp(), clock_timestamp() + INTERVAL '61 seconds')
    `,
  );
});

test("a request without identity headers is served as before and admits nothing", async () => {
  // Backward compatibility: the web deploys first while the old orchestrator runs.
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret, TOMVERSE_AMUX_EXECUTION_API_ENABLED: undefined }, async () => {
    const admissionsBefore = await prisma.amuxOrchestratorWrite.count();
    const receiptsBefore = await prisma.amuxOrchestratorWriteReceipt.count();
    const response = await recoverPost(post("/api/internal/amux/execution/recover", {}));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "execution_api_disabled");
    assert.equal(await prisma.amuxOrchestratorWrite.count(), admissionsBefore);
    assert.equal(await prisma.amuxOrchestratorWriteReceipt.count(), receiptsBefore);
  });
});

test("a second admission of the same request id is refused and writes nothing", async () => {
  // 완료 조건: 같은 요청 id의 두 번째 접수는 409 duplicate_request; 접수 실패면 쓰기가 0.
  const card = await claimableCard("AMUX-HALT-DUPLICATE");
  await withEnv(
    {
      TOMVERSE_AMUX_SYNC_SECRET: secret,
      TOMVERSE_AMUX_EXECUTION_API_ENABLED: "1",
      TOMVERSE_AMUX_WORKER_CATALOG_JSON: card.catalog,
    },
    async () => {
      const { requestId } = await admit(12_000);
      const response = await claimPost(post("/api/internal/amux/claim", identityHeaders(requestId), card.body));
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "Duplicate request.", reason: "duplicate_request" });
      const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: card.taskId } });
      assert.equal(task.owner, null);
      assert.equal(task.revision, 0);
      assert.equal(await prisma.amuxRouteDecision.count({ where: { taskId: card.taskId } }), 0);
      assert.equal((await receiptsOf(requestId)).length, 0);
    },
  );
});

test("an admitted claim writes its receipts in the claim's own transaction", async () => {
  // 완료 조건: 영수증은 쓰기와 같은 트랜잭션에만 있다.
  const card = await claimableCard("AMUX-HALT-CLAIM");
  await withEnv(
    {
      TOMVERSE_AMUX_SYNC_SECRET: secret,
      TOMVERSE_AMUX_EXECUTION_API_ENABLED: "1",
      TOMVERSE_AMUX_WORKER_CATALOG_JSON: card.catalog,
    },
    async () => {
      const requestId = randomUUID();
      const response = await claimPost(post("/api/internal/amux/claim", identityHeaders(requestId), card.body));
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.claimed, true);
      const receipts = await receiptsOf(requestId);
      assert.deepEqual(
        receipts.map((receipt) => [receipt.targetKind, receipt.targetId, receipt.rowCount]),
        [
          ["claim_decision", body.decision_id, 1],
          ["work_item", card.taskId, 1],
        ],
      );
      const task = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: card.taskId } });
      assert.equal(task.owner, card.worker);
      // The receipt's clock is the transaction's, not later than the claim.
      for (const receipt of receipts) {
        assert.ok(receipt.committedAt.getTime() >= task.claimedAt!.getTime());
      }
      // A definite acknowledgement succeeds with receipts.
      const ack = await ackPost(post("/api/internal/amux/orchestrator/ack", {}, { request_id: requestId, kind: "definite" }));
      assert.equal(ack.status, 200);
      assert.deepEqual(await ack.json(), { acked: true });
      assert.notEqual((await writeRow(requestId)).ackedAt, null);
      // And a receipt after the acknowledgement is refused by the database.
      await rejectsWith(
        prisma.$executeRaw`
          INSERT INTO "AmuxOrchestratorWriteReceipt" ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
          VALUES (${randomUUID()}, ${requestId}, 'work_item', ${card.taskId}, 1, clock_timestamp())
        `,
        /AMUX_ORCHESTRATOR_WRITE_CLOSED/,
      );
    },
  );
});

test("a refusal-only claim and a rolled-back write leave no receipt", async () => {
  // 완료 조건: 거절 감사만 있는 트랜잭션은 영수증을 남기지 않는다; 롤백된 쓰기에는
  // 영수증이 없다.
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret, TOMVERSE_AMUX_EXECUTION_API_ENABLED: undefined }, async () => {
    const requestId = randomUUID();
    const refusalAuditsBefore = await prisma.adminAuditLog.count({
      where: { action: "amux.claim.refused" },
    });
    const response = await claimPost(
      post("/api/internal/amux/claim", identityHeaders(requestId), { task_id: "x" }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { claimed: false, reason: "execution_api_disabled" });
    assert.equal((await receiptsOf(requestId)).length, 0);
    // The refusal audit itself was written.
    assert.equal(await prisma.adminAuditLog.count({
      where: { action: "amux.claim.refused" },
    }), refusalAuditsBefore + 1);
    // The definite acknowledgement of a refusal succeeds too.
    const ack = await ackPost(post("/api/internal/amux/orchestrator/ack", {}, { request_id: requestId, kind: "definite" }));
    assert.equal(ack.status, 200);
  });

  const taskId = await createTodo("AMUX-HALT-ROLLBACK");
  await withAmuxRouteBudget(async () => {
    const requestId = randomUUID();
    assert.deepEqual(
      await admitAmuxOrchestratorWrite({ requestId, instanceId: randomUUID(), callKind: "recover" }),
      { admitted: true },
    );
    await assert.rejects(
      withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ownershipRecoveryWrite, async (tx, context) => {
        await tx.amuxWorkItem.update({ where: { id: taskId }, data: { priority: "p0" } });
        context.recordReceipt("work_item", taskId, 1);
        throw new Error("rolled back after the change");
      }),
      /rolled back after the change/,
    );
    assert.equal((await receiptsOf(requestId)).length, 0);
    assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } })).priority, "p1");

    // The same change committed leaves exactly its receipt.
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ownershipRecoveryWrite, async (tx, context) => {
      await tx.amuxWorkItem.update({ where: { id: taskId }, data: { priority: "p0" } });
      context.recordReceipt("work_item", taskId, 1);
    });
    assert.deepEqual(
      (await receiptsOf(requestId)).map((receipt) => [receipt.targetKind, receipt.targetId]),
      [["work_item", taskId]],
    );
  }, 30_000);
});

test("a no_commit acknowledgement is refused when the request has a receipt, and succeeds when it has none", async () => {
  // 완료 조건: no_commit ack는 영수증이 있으면 거절과 정지; ack는 멱등.
  const withReceipt = await admit(12_000);
  await prisma.$transaction(async (tx) => {
    await lockAmuxOrchestratorAdmission(tx, withReceipt.requestId);
    await tx.$executeRaw`
      INSERT INTO "AmuxOrchestratorWriteReceipt" ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
      VALUES (${randomUUID()}, ${withReceipt.requestId}, 'quota_observation_batch', NULL, 3, clock_timestamp())
    `;
  });
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    const refused = await ackPost(
      post("/api/internal/amux/orchestrator/ack", {}, { request_id: withReceipt.requestId, kind: "no_commit" }),
    );
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { acked: false, reason: "receipts_present" });
    assert.equal((await writeRow(withReceipt.requestId)).ackedAt, null);

    const clean = await admit(12_000);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ok = await ackPost(
        post("/api/internal/amux/orchestrator/ack", {}, { request_id: clean.requestId, kind: "no_commit" }),
      );
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { acked: true });
    }
    const acked = await writeRow(clean.requestId);
    assert.notEqual(acked.ackedAt, null);

    // A request the server never admitted committed nothing.
    const unknown = await ackPost(
      post("/api/internal/amux/orchestrator/ack", {}, { request_id: randomUUID(), kind: "no_commit" }),
    );
    assert.equal(unknown.status, 200);
  });
});

test("the resolver leaves an admission undecided before its deadline plus five seconds, then decides it on the evidence", async () => {
  // 완료 조건: 기한 전 미정, 기한+5초 뒤 영수증 0은 롤백 확정과 시스템 감사, 영수증
  // 1 이상은 사람 확인 필요. 인스턴스 id와 무관.
  const empty = await admit(1_000, "recover");
  const committed = await admit(1_000, "auto_promotion_tick");
  await prisma.$transaction(async (tx) => {
    await lockAmuxOrchestratorAdmission(tx, committed.requestId);
    await tx.$executeRaw`
      INSERT INTO "AmuxOrchestratorWriteReceipt" ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
      VALUES (${randomUUID()}, ${committed.requestId}, 'auto_promotion_grant', ${randomUUID()}, 1, clock_timestamp())
    `;
  });
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    await readState();
    assert.equal((await writeRow(empty.requestId)).resolvedAt, null, "undecided before the grace");
    await delay(1_000 + GRACE_MS + 500);
    const state = await readState();
    const resolved = await writeRow(empty.requestId);
    assert.equal(resolved.resolution, "no_commit");
    assert.notEqual(resolved.resolvedAt, null);
    const audits = await prisma.adminAuditLog.findMany({
      where: { action: "amux.orchestrator.write_resolved", targetId: empty.requestId },
    });
    assert.equal(audits.length, 1);
    const metadata = audits[0]!.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ["call_kind", "request_id", "resolution", "systemActor"]);
    assert.equal(metadata.systemActor, "tomverse-amux-orchestrator");
    assert.equal(audits[0]!.actorUserId, null);

    const person = await writeRow(committed.requestId);
    assert.equal(person.resolvedAt, null, "a receipt is never resolved as no_commit");
    assert.ok(
      state.human_required.some(
        (row) => row.request_id === committed.requestId && row.receipt_count === 1 && row.call_kind === "auto_promotion_tick",
      ),
    );
  });
});

test("the resolver waits for a write holding the admission lock and then counts its committed receipt", async () => {
  // 완료 조건: 접수 행을 잡은 채 커밋 중인 쓰기 트랜잭션이 있으면 판정은 그 커밋 뒤에
  // 영수증을 센다. Without the resolver's row lock -- or with the count read in
  // the locking statement's own snapshot -- the resolver would count zero while
  // the write runs, and this would not come back as `human_required`.
  const { requestId } = await admit(1_000);
  await delay(1_000 + GRACE_MS + 500);

  let lockTaken!: () => void;
  const taken = new Promise<void>((resolve) => (lockTaken = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const write = prisma.$transaction(
    async (tx) => {
      const admission = await lockAmuxOrchestratorAdmission(tx, requestId);
      assert.deepEqual(admission, { acked: false, resolved: false });
      lockTaken();
      await released;
      await tx.$executeRaw`
        INSERT INTO "AmuxOrchestratorWriteReceipt" ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
        VALUES (${randomUUID()}, ${requestId}, 'work_item', 'TASK-LOCKED', 1, clock_timestamp())
      `;
    },
    { maxWait: 5_000, timeout: 30_000 },
  );
  await taken;
  const judged = prisma.$transaction((tx) => resolveAmuxOrchestratorWriteLocked(tx, requestId), {
    maxWait: 5_000,
    timeout: 30_000,
  });
  await delay(500);
  // Still waiting on the lock: nothing decided while the write runs.
  assert.equal((await writeRow(requestId)).resolvedAt, null);
  release();
  await write;
  assert.equal(await judged, "human_required");
  const row = await writeRow(requestId);
  assert.equal(row.resolvedAt, null);
  assert.equal(row.resolution, null);
});

test("a write whose admission is resolved rolls back before changing anything, and the database refuses its receipt", async () => {
  // 완료 조건: 해결된 접수에 영수증을 넣으려는 쓰기는 롤백된다.
  const taskId = await createTodo("AMUX-HALT-CLOSED");
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    await withAmuxRouteBudget(async () => {
      const requestId = randomUUID();
      await admitAmuxOrchestratorWrite({ requestId, instanceId: randomUUID(), callKind: "claim" });
      // A person closes it: the halt for the request is recorded and cleared.
      const halt = await recordHalt({ halt_key: requestId, reason_code: "claim_outcome_unknown", request_id: requestId });
      await clearAmuxOrchestratorHalt({
        session: ownerSession(),
        request: adminRequest(),
        haltId: halt.halt_id,
        haltKeyPrefix: requestId.slice(0, 8),
      });
      assert.equal((await writeRow(requestId)).resolution, "human_confirmed");
      await assert.rejects(
        withAmuxDbBoundary(AMUX_DB_BOUNDARIES.ownershipRecoveryWrite, async (tx, context) => {
          await tx.amuxWorkItem.update({ where: { id: taskId }, data: { priority: "p0" } });
          context.recordReceipt("work_item", taskId, 1);
        }),
        (error) => error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_ADMISSION_CLOSED",
      );
      assert.equal((await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: taskId } })).priority, "p1");
      await rejectsWith(
        prisma.$executeRaw`
          INSERT INTO "AmuxOrchestratorWriteReceipt" ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
          VALUES (${randomUUID()}, ${requestId}, 'work_item', ${taskId}, 1, clock_timestamp())
        `,
        /AMUX_ORCHESTRATOR_WRITE_CLOSED/,
      );
    }, 30_000);
  });
});

test("a halt record is idempotent by key, audited in its own transaction, and never updated except by one clear", async () => {
  // 완료 조건: haltKey 멱등, 사유 코드 CHECK, 해제 외 갱신 거절 trigger, 시스템 감사
  // 같은 트랜잭션, 내부 route가 해제를 받지 않는다.
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    const haltKey = randomUUID();
    const first = await recordHalt({ halt_key: haltKey, reason_code: "selection_read_failures" });
    const second = await recordHalt({ halt_key: haltKey, reason_code: "selection_read_failures" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.halt_id, first.halt_id);
    const audits = await prisma.adminAuditLog.findMany({
      where: { action: "amux.orchestrator.halted", targetId: first.halt_id },
    });
    assert.equal(audits.length, 1);
    assert.deepEqual(
      Object.keys(audits[0]!.metadata as object).sort(),
      ["halt_id", "halt_key", "reason_code", "systemActor"],
    );

    // A clear through the internal route is not a thing it accepts.
    const refused = await haltRecordPost(
      post("/api/internal/amux/orchestrator/halt", {}, {
        halt_key: haltKey,
        reason_code: "selection_read_failures",
        cleared_at: new Date().toISOString(),
      }),
    );
    assert.equal(refused.status, 400);

    // The database refuses a reason outside the list, a halt without its
    // audit, any update but the clear, and every delete.
    await rejectsWith(
      prisma.$executeRaw`
        INSERT INTO "AmuxOrchestratorHalt" ("id", "haltKey", "reasonCode", "openedAt")
        VALUES (${randomUUID()}, ${randomUUID()}, 'operator_note', clock_timestamp())
      `,
    );
    await rejectsWith(
      prisma.$executeRaw`
        INSERT INTO "AmuxOrchestratorHalt" ("id", "haltKey", "reasonCode", "openedAt")
        VALUES (${randomUUID()}, ${randomUUID()}, 'contract_violation', clock_timestamp())
      `,
      /AMUX_ORCHESTRATOR_HALT_UNAUDITED/,
    );
    await rejectsWith(
      prisma.$executeRaw`UPDATE "AmuxOrchestratorHalt" SET "reasonCode" = 'contract_violation' WHERE "id" = ${first.halt_id}`,
      /AMUX_ORCHESTRATOR_HALT_CLEARED_ONCE|AMUX_ORCHESTRATOR_HALT_CLEAR_INCOMPLETE/,
    );
    await rejectsWith(
      prisma.$executeRaw`
        UPDATE "AmuxOrchestratorHalt"
        SET "clearedAt" = clock_timestamp(), "clearedByUserId" = 'someone', "clearAuditLogId" = 'no-such-audit'
        WHERE "id" = ${first.halt_id}
      `,
      /AMUX_ORCHESTRATOR_HALT_CLEAR_UNAUDITED/,
    );
    await rejectsWith(
      prisma.$executeRaw`DELETE FROM "AmuxOrchestratorHalt" WHERE "id" = ${first.halt_id}`,
      /AMUX_ORCHESTRATOR_HALT_RETAINED/,
    );

    // The one clear, then nothing more.
    const session = ownerSession();
    await clearAmuxOrchestratorHalt({
      session,
      request: adminRequest(),
      haltId: first.halt_id,
      haltKeyPrefix: haltKey.slice(0, 8),
    });
    await rejectsWith(
      prisma.$executeRaw`UPDATE "AmuxOrchestratorHalt" SET "clearedByUserId" = 'someone-else' WHERE "id" = ${first.halt_id}`,
      /AMUX_ORCHESTRATOR_HALT_CLEARED_ONCE/,
    );
    const state = await readState([haltKey]);
    assert.deepEqual(state.halts, [{ halt_key: haltKey, halt_id: first.halt_id, cleared: true }]);
  });
});

test("clearing needs the typed halt key prefix, audits the person in the same transaction and closes the request", async () => {
  // 완료 조건: haltKey 앞 8자가 틀리면 거절, 사람 감사 같은 트랜잭션, 관련 접수를
  // 닫음, 원래 작업을 호출하지 않는다.
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    const { requestId } = await admit(12_000, "claim");
    const halt = await recordHalt({ halt_key: requestId, reason_code: "claim_outcome_unknown", request_id: requestId });
    const session = ownerSession();
    await assert.rejects(
      clearAmuxOrchestratorHalt({ session, request: adminRequest(), haltId: halt.halt_id, haltKeyPrefix: "00000000" }),
      (error) => (error as { code?: string }).code === "halt_key_mismatch",
    );
    assert.equal(
      await prisma.adminAuditLog.count({ where: { action: "amux.orchestrator.halt_cleared", targetId: halt.halt_id } }),
      0,
    );
    assert.equal((await writeRow(requestId)).resolvedAt, null);

    const result = await clearAmuxOrchestratorHalt({
      session,
      request: adminRequest(),
      haltId: halt.halt_id,
      haltKeyPrefix: requestId.slice(0, 8).toUpperCase(),
    });
    assert.deepEqual(result, { haltId: halt.halt_id, admissionClosed: true });
    const stored = await prisma.amuxOrchestratorHalt.findUniqueOrThrow({ where: { id: halt.halt_id } });
    const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: stored.clearAuditLogId! } });
    assert.equal(audit.action, "amux.orchestrator.halt_cleared");
    assert.equal(audit.actorUserId, session.user!.id);
    assert.equal(stored.clearedByUserId, session.user!.id);
    const write = await writeRow(requestId);
    assert.equal(write.resolution, "human_confirmed");
    // Nothing was claimed, recovered or promoted by the clear.
    assert.equal((await receiptsOf(requestId)).length, 0);

    await assert.rejects(
      clearAmuxOrchestratorHalt({ session, request: adminRequest(), haltId: halt.halt_id, haltKeyPrefix: requestId.slice(0, 8) }),
      (error) => (error as { code?: string }).code === "already_cleared",
    );
  });
});

test("the state read reports halts a person cleared, and an unrecorded key as unknown rather than cleared", async () => {
  // 완료 조건: 빈 목록 읽기가 메모리 정지를 풀지 않는다 -- the server side: a key
  // the server has no row for is absent from `halts`, never `cleared: true`.
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    const unknownKey = randomUUID();
    const state = await readState([unknownKey]);
    assert.deepEqual(state.halts, []);
  });
});

test("a process that died after a request and before its answer finds it undecided, then decided", async () => {
  // 완료 조건: 재시작한 프로세스가 awaiting_deadline으로 기다린 뒤, 커밋이 없었으면
  // 스케줄을 시작하고 커밋이 있었으면 정지한다 -- the server's half: the state
  // read reports the unacknowledged admission as undecided until its deadline
  // plus the grace, then as resolved (nothing committed) or needing a person.
  const nothing = await admit(1_000, "claim");
  const something = await admit(1_000, "claim");
  await prisma.$transaction(async (tx) => {
    await lockAmuxOrchestratorAdmission(tx, something.requestId);
    await tx.$executeRaw`
      INSERT INTO "AmuxOrchestratorWriteReceipt" ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
      VALUES (${randomUUID()}, ${something.requestId}, 'work_item', 'TASK-DIED', 1, clock_timestamp())
    `;
  });
  await withEnv({ TOMVERSE_AMUX_SYNC_SECRET: secret }, async () => {
    const early = await readState();
    assert.equal(early.human_required.some((row) => row.request_id === something.requestId), false);
    assert.equal((await writeRow(nothing.requestId)).resolvedAt, null);
    await delay(1_000 + GRACE_MS + 500);
    const late = await readState();
    assert.equal((await writeRow(nothing.requestId)).resolution, "no_commit");
    assert.equal(late.human_required.some((row) => row.request_id === something.requestId), true);
  });
});
