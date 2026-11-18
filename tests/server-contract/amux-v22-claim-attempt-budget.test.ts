import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Production 2026-11-06 to 11-07: one Task with its five attempts spent was
// assigned 149 times. Execution start refused it every time, the unstarted
// release requeued it, and the next tick (one assignment per tick) took it
// again ahead of every lower-scored Task. A Task whose attempts were spent was
// skipped by the claim, the same budget execution start applied. Owner
// direction 2026-11-18: no count of attempts spends a card any more, so the
// claim skips none for it; a Task failing the same way again and again only
// waits longer (result_retry_backoff) while the next Task is tried.

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
// Owner direction 2026-11-18: thirty attempts behind it spend nothing.
const attempts: Record<string, number> = { [spentTask]: 30, [freshTask]: 0 };
const assigned: string[] = [];
// Tasks whose newest run ended as a platform failure a second ago.
const backingOff = new Set<string>();
// Tasks whose newest run failed on the card's own result, with how many runs
// in a row failed the same way and how long ago the newest ended.
const resultBackingOff = new Map<string, { streak: number; endedAgoMs: number }>();
const INFRA_REASON = "infra_no_result";
const auditMetadata: Array<Record<string, unknown>> = [];

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
    // readAmuxAttemptBudgetFacts: one statement for the budget.
    if (sql.includes('COUNT(*)::int AS "rows"')) {
      const id = String(values.at(-1));
      const used = attempts[id] ?? 0;
      // The wait starts at the third platform failure in a row (amuxInfraRetryDelayMs).
      const infra = backingOff.has(id) ? 3 : 0;
      const result = resultBackingOff.get(id);
      return [{ rows: used, greatest: used || null, infra, infraWindow: infra,
        reserved: BigInt(used) * BigInt("3400000"),
        lastEndedAt: infra ? new Date(now.getTime() - 1_000) :
          result ? new Date(now.getTime() - result.endedAgoMs) : null,
        lastEndedReason: infra ? INFRA_REASON : result ? "reported_result" : null }];
    }
    // readAmuxResultFailureStreak: the newest runs the card's own result failed.
    if (sql.includes('SELECT a."outcome", a."reason"')) {
      const id = values.find((value) => typeof value === "string" && value in attempts) as string;
      return Array.from({ length: resultBackingOff.get(id)?.streak ?? 0 },
        () => ({ outcome: "failed", reason: "reported_result" }));
    }
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
  amuxV22WorkerAssignment: { findMany: async () => [], groupBy: async () => [], create: async () => undefined },
  // No owner ceiling re-approval stands for this Task.
  adminAuditLog: { findMany: async () => [] },
  amuxIdeaUnitDecision: { findUnique: async () => ({
    confirmationSnapshot: { card: { task: { costReceipt: receipt } } },
  }) },
  amuxExecutionAttempt: { findMany: async () => [], aggregate: async ({ where }: Where) => {
    const used = attempts[String(where.taskId)] ?? 0;
    return { _count: { _all: used }, _max: { attemptNumber: used || null },
      _sum: { reservedCostMicrousd: BigInt(used) * BigInt("3400000") } };
  } },
};

mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (client: unknown) => unknown) => work(tx) },
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeSystemAuditLog: async (input: { metadata: Record<string, unknown> }) => {
    auditMetadata.push(input.metadata);
    return "assignment-audit";
  },
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
  v4TaskReceiptForApprovedRoutes: (_approved: unknown, current: unknown) => current,
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

test("a Task with thirty attempts behind it is assigned like any other: no count of attempts stops a card", async () => {
  assigned.length = 0;
  attempts[spentTask] = 30;
  attempts[freshTask] = 0;
  // Its reservation passes the receipt's approved ceiling: recorded on the
  // assignment and logged, never refused (owner decision 2026-11-14).
  const warn = mock.method(console, "warn", () => undefined);
  let result;
  try {
    result = await (await service).tickV22WorkerClaim();
  } finally { warn.mock.restore(); }
  assert.equal(result.claimed, true);
  assert.equal(result.claimed && result.taskId, spentTask, "the higher-scored Task is not passed over");
  assert.ok(assigned.includes(spentTask), "it is reserved for a start that will not refuse it");
  assert.deepEqual(auditMetadata.find((metadata) => metadata.ceilingOverrun !== undefined)?.ceilingOverrun,
    { ceilingMicroUsd: "3400000", priorReservedMicroUsd: "102000000", projectedMicroUsd: "105400000" });
  // A thousand attempts change nothing either.
  assigned.length = 0;
  attempts[spentTask] = 1_000;
  const again = mock.method(console, "warn", () => undefined);
  try {
    const next = await (await service).tickV22WorkerClaim();
    assert.equal(next.claimed && next.taskId, spentTask);
  } finally { again.mock.restore(); }
});

test("a Task failing the same way again and again waits out a longer backoff and the next Task is assigned", async () => {
  assigned.length = 0;
  attempts[spentTask] = 6;
  attempts[freshTask] = 0;
  // Six runs in a row failed the same way (a wait of four minutes); the newest ended a second ago.
  resultBackingOff.set(spentTask, { streak: 6, endedAgoMs: 1_000 });
  try {
    const result = await (await service).tickV22WorkerClaim();
    assert.equal(result.claimed && result.taskId, freshTask);
    assert.deepEqual(assigned, [freshTask], "the waiting Task is passed over, never blocked, and holds nothing after it");

    // The wait is over: the same Task is assigned again, however often it failed.
    assigned.length = 0;
    resultBackingOff.set(spentTask, { streak: 6, endedAgoMs: 5 * 60_000 });
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const later = await (await service).tickV22WorkerClaim();
      assert.equal(later.claimed && later.taskId, spentTask);
    } finally { warn.mock.restore(); }
    // Three runs in a row are not yet a repeat: no wait.
    assigned.length = 0;
    resultBackingOff.set(spentTask, { streak: 3, endedAgoMs: 1_000 });
    const early = mock.method(console, "warn", () => undefined);
    try {
      const third = await (await service).tickV22WorkerClaim();
      assert.equal(third.claimed && third.taskId, spentTask);
    } finally { early.mock.restore(); }
  } finally {
    resultBackingOff.clear();
  }
});

test("a Task waiting out its platform-failure backoff is passed over and the next Task is assigned", async () => {
  const { AMUX_INFRA_FAILURE_REASONS } = await import(mod("lib/amux/infraFailureCore.ts"));
  assert.ok(AMUX_INFRA_FAILURE_REASONS.includes(INFRA_REASON), "the fixture uses a real infra reason");
  assigned.length = 0;
  attempts[spentTask] = 3;
  attempts[freshTask] = 0;
  backingOff.add(spentTask);
  try {
    const result = await (await service).tickV22WorkerClaim();
    assert.equal(result.claimed, true);
    assert.equal(result.claimed && result.taskId, freshTask);
    assert.deepEqual(assigned, [freshTask], "the waiting Task holds nothing after it");
  } finally {
    backingOff.clear();
  }
});
