import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Production 2026-11-06 to 11-07: one Task with its five attempts spent was
// assigned 149 times. Execution start refused it every time, the unstarted
// release requeued it, and the next tick (one assignment per tick) took it
// again ahead of every lower-scored Task. A spent Task is now skipped by the
// claim, the same budget execution start applies, and the next one is tried.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-11-07T05:14:38.000Z");
const spentTask = "task-spent";
const freshTask = "task-fresh";
const workerName = "codex-chore";
const receipt = {
  role: "implement", grade: "routine", catalogVersion: "v1",
  catalogDigest: "c".repeat(64), pricingVersion: "price-v1",
  gradeRulesVersion: "grade-v1", caps: {}, ceilingMicroUsd: "3400000",
  receiptDigest: "e".repeat(64),
  routes: [{ routeId: "chore-route", workerName, provider: "openai",
    modelId: "gpt-6-1-sol", routePolicyDigest: "d".repeat(64),
    perAttemptMicroUsd: "3400000" }],
};
const approved = { approvalId: "catalog-one", catalogDigest: receipt.catalogDigest,
  catalog: { pricingVersion: "price-v1", routes: [{ routeId: "chore-route",
    modelId: "gpt-6-1-sol", uncachedInputMicroUsdPerMillion: 1_000_000,
    cacheReadMicroUsdPerMillion: 100_000, cacheWriteMicroUsdPerMillion: 200_000,
    outputMicroUsdPerMillion: 2_000_000 }] }, receipt };
const attempts: Record<string, number> = { [spentTask]: 5, [freshTask]: 0 };
const assigned: string[] = [];

const workers = [workerName, "copilot-chore", "claude-review"].map((name) => ({
  worker_name: name, provider: "openai", model: "gpt-6-1-sol",
  routing_roles: ["implement"], tool_capabilities: ["repo_write"],
  archived: false, paused: false, isolated: false, blocked: false,
}));
const runtime = (name: string) => ({ workerName: name,
  instanceId: `${name}-instance`, generation: 1, status: "idle",
  dispatchReady: true, protocolCapabilities: [],
  leaseExpiresAt: new Date("2026-11-07T05:16:00.000Z") });

type Where = { where: { id?: string; taskId?: string } };
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    // The spent Task scores higher, so it is the first candidate.
    if (sql.includes("ORDER BY CASE WHEN lane")) return [{ id: spentTask }, { id: freshTask }];
    if (sql.includes("FROM \"AmuxWorkItem\" WHERE \"id\"") &&
        sql.includes("FOR UPDATE")) return [{ id: values[0] }];
    if (sql.includes("FROM \"AmuxExecutionAttempt\" a")) return [];
    if (sql.includes("FROM \"AmuxWorkerRuntime\"") && sql.includes("FOR UPDATE"))
      return [runtime(String(values[0]))];
    throw new Error(`unexpected SQL: ${sql}`);
  },
  amuxV22LaneDecision: { findFirst: async () => null },
  amuxV22TaskQuestion: { findFirst: async () => null },
  amuxWorkItem: {
    findUnique: async ({ where }: Where) => ({ status: "todo",
      sourceSystem: "admin-idea-v4", cardType: "task", archivedAt: null,
      owner: null, claimedAt: null, revision: 1, taskRole: "implement",
      executionGrade: "routine", v22ReceiptId: `promotion-${where.id}`,
      v22AssignmentId: null }),
    findMany: async () => [],
    updateMany: async ({ where }: Where) => {
      assigned.push(String(where.id));
      return { count: 1 };
    },
  },
  amuxV22PromotionReceipt: { findUnique: async ({ where }: Where) => ({
    id: where.id, workItemId: String(where.id).replace("promotion-", ""),
    sourceApprovalId: "source-one", briefDigest: "b".repeat(64) }) },
  amuxWorkerRuntime: { findMany: async () => workers.map((worker) =>
    runtime(worker.worker_name)) },
  amuxV22WorkerAssignment: { findMany: async () => [], create: async () => undefined },
  amuxIdeaUnitDecision: { findUnique: async () => ({
    confirmationSnapshot: { card: { task: { costReceipt: receipt } } },
  }) },
  amuxExecutionAttempt: { aggregate: async ({ where }: Where) => {
    const used = attempts[String(where.taskId)] ?? 0;
    return { _count: { _all: used }, _max: { attemptNumber: used || null },
      _sum: { reservedCostMicrousd: BigInt(used) * BigInt("3400000") } };
  } },
};

mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (client: unknown) => unknown) => work(tx) },
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async () => "assignment-audit",
} });
mock.module(mod("lib/amux/incident.ts"), { namedExports: {
  lockAmuxAdmissionAndReadIncident: async () => ({ blocks_admission: false }),
} });
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), { namedExports: {
  findOpenAmuxOrchestratorHalt: async () => null,
} });
mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxAssignmentCatalogs: async () => ({ workers: [], v22: workers, ceilings: null }),
} });
mock.module(mod("lib/amux/telemetry.ts"), { namedExports: {
  getAmuxWorkerTelemetry: async () => new Map(),
} });
mock.module(mod("lib/amux/autoPromotionService.ts"), { namedExports: {
  TICK_TRANSACTION_LIMITS: {},
  withAutoTransaction: async (_id: string, _limits: unknown,
    work: (client: unknown, at: Date, record: () => void) => unknown) =>
    work(tx, now, () => undefined),
} });
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
  calculateCurrentApprovedAmuxV4TaskCost: async () => approved,
} });
mock.module(mod("lib/amux/v4TaskCostCeilingCore.ts"), { namedExports: {
  checkV4TaskApprovedCeiling: () => ({ decision: "allow" }),
  v4TaskCeilingDecision: (check: { decision: string }) => check.decision,
} });
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  readAmuxV22RecoveryAuthority: async () => null,
  amuxV22ApiModelAccessCurrent: () => true,
} });
mock.module(mod("lib/amux/v22LegacySafeStopFence.ts"), { namedExports: {
  amuxV22SafeStopFencedWorkers: async () => new Set(),
} });
mock.module(mod("lib/amux/v4TaskReadyService.ts"), { namedExports: {
  loadAmuxV4TaskReadyContext: async () => ({}),
  evaluateAmuxV4TaskReadyInTransaction: async () => ({ ready: true,
    sourceApprovalId: "source-one", briefDigest: "b".repeat(64) }),
} });

const service = import(mod("lib/amux/v22WorkerClaimService.ts"));

test("a Task with its attempts spent is skipped and the next Task is assigned", async () => {
  const previous = process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM;
  process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM = "enabled";
  try {
    const result = await (await service).tickV22WorkerClaim();
    assert.equal(result.claimed, true);
    assert.equal(result.claimed && result.taskId, freshTask);
    assert.deepEqual(assigned, [freshTask], "the spent Task is never reserved");

    // With only the spent Task left, the tick assigns nothing rather than a
    // reservation execution start would refuse.
    assigned.length = 0;
    attempts[freshTask] = 5;
    const none = await (await service).tickV22WorkerClaim();
    assert.deepEqual(none, { claimed: false, reason: "no_ready_candidate" });
    assert.deepEqual(assigned, []);

    // One attempt left still assigns (the fifth attempt is allowed).
    attempts[freshTask] = 4;
    const last = await (await service).tickV22WorkerClaim();
    assert.equal(last.claimed && last.taskId, freshTask);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM;
    else process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM = previous;
  }
});
