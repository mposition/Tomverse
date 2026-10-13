import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-13T12:00:00.000Z");
const taskId = "task-one";
const assignmentId = "assignment-one";
const attemptId = "attempt-one";
const worker = "worker-one";
const instanceId = "instance-one";
const apiCapability = ["read_only_api_retry_v1"];
let runtimeCapabilities = apiCapability;
let recoveryAuthority: Record<string, unknown> | null = null;
let assignmentRecoveryApprovalId: string | null = null;
let scenario: "start" | "delivery" | "generic-start" | "generic-delivery" |
  "heartbeat" = "start";
let decryptCalls = 0;
let liveAttemptReads = 0;
let taskWrites = 0;
let runtimeWrites = 0;
let attemptWrites = 0;
let deliveryWrites = 0;
let auditWrites = 0;

const receipt = {
  role: "investigate", grade: "high", catalogVersion: "v1",
  catalogDigest: "c".repeat(64), pricingVersion: "price-v1",
  gradeRulesVersion: "grade-v1", caps: {}, ceilingMicroUsd: "3400000",
  receiptDigest: "e".repeat(64),
  routes: [{ routeId: "read-only-route", workerName: worker,
    provider: "anthropic", modelId: "claude-opus-5-5",
    routePolicyDigest: "d".repeat(64), perAttemptMicroUsd: "3400000" }],
};

const runtimeRow = () => ({ workerName: worker, instanceId, generation: 1,
  status: scenario === "start" || scenario === "generic-start" ? "idle" : "busy",
  dispatchReady: scenario === "start" || scenario === "generic-start",
  protocolCapabilities: runtimeCapabilities,
  heartbeatAt: new Date("2026-10-13T11:59:30.000Z"),
  leaseExpiresAt: new Date("2026-10-13T12:01:00.000Z") });

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes('JOIN "AmuxWorkDelivery"')) return [{
      runtimeLeaseExpiresAt: runtimeRow().leaseExpiresAt,
      attemptLeaseExpiresAt: runtimeRow().leaseExpiresAt,
      v22AssignmentId: scenario === "generic-delivery" ? null : assignmentId,
      attemptId, taskId, worker,
      workerInstanceId: instanceId, workerGeneration: 1, taskRevision: 6,
      prompt: scenario === "generic-delivery" ? "ordinary prompt" :
        "amux-v22:sealed-brief", status: "queued",
      receiptId: null, leasedAt: null, leaseExpiresAt: null,
      acknowledgedAt: null, cancelledAt: null,
    }];
    if (sql.includes('FROM "AmuxWorkerRuntime"')) return [runtimeRow()];
    if (sql.includes('FROM "AmuxWorkItem"')) return [{
      id: taskId, sourceSystem: "admin-idea-v4", v22AssignmentId: assignmentId,
      owner: worker, status: "todo", revision: 6,
      claimedAt: new Date("2026-10-13T11:59:00.000Z"), archivedAt: null,
      projectKey: null, teamKey: null,
      estimatedCostMicrousd: BigInt("3400000"), requiresHumanReview: true,
      reviewSpecialty: null, executionBrief: "sealed",
      executionBriefDigest: "b".repeat(64),
    }];
    throw new Error(`unexpected SQL: ${sql}`);
  },
  amuxWorkItem: {
    findUnique: async (input: { select: Record<string, unknown> }) => {
      if (input.select.sourceSnapshot) return { sourceSnapshot: { ideaId: "idea-one" } };
      if (scenario === "generic-start") return {
        sourceSystem: "manual", projectKey: null, teamKey: null, effortPoints: 1,
        estimatedCostMicrousd: BigInt(1),
      };
      if (scenario === "delivery") return {
        sourceSystem: "admin-idea-v4", cardType: "task",
        v4BriefCiphertext: Buffer.from("sealed"), v4BriefKeyId: "key-one",
        v4BriefKeyVersion: 1, v4BriefDigest: "b".repeat(64),
        v4BriefDigestKeyId: "digest-key-one", v4BriefPurgedAt: null,
        v22AssignmentId: assignmentId,
      };
      return { kind: "task", cardType: "task", taskRole: "investigate",
        executionGrade: "high", v22AssignmentId: assignmentId,
        v4SourceApprovalId: "source-one", v4BriefDigest: "b".repeat(64),
        v22ReceiptId: "promotion-one", reviewPrNumber: null };
    },
    updateMany: async () => { taskWrites += 1; return { count: 1 }; },
  },
  amuxV22WorkerAssignment: { findUnique: async () => ({
    workItemId: taskId, taskRevision: 5, workerName: worker,
    workerInstanceId: instanceId, workerGeneration: 1,
    modelId: "claude-opus-5-5", role: "investigate", grade: "high",
    provider: "anthropic", routeId: "read-only-route",
    routePolicyDigest: "d".repeat(64), catalogApprovalId: "catalog-one",
    catalogVersion: "v1", costReceiptDigest: receipt.receiptDigest,
    recoveryApprovalId: assignmentRecoveryApprovalId,
    perAttemptMicroUsd: BigInt("3400000"),
  }) },
  amuxV22PromotionReceipt: { findUnique: async () => ({ workItemId: taskId,
    sourceApprovalId: "source-one", briefDigest: "b".repeat(64) }) },
  amuxIdeaUnitDecision: { findUnique: async () => ({
    confirmationSnapshot: { card: { task: { costReceipt: receipt } } },
  }) },
  amuxExecutionAttempt: {
    aggregate: async () => ({ _count: { _all: 0 },
      _max: { attemptNumber: null }, _sum: { reservedCostMicrousd: null } }),
    findUnique: async () => ({ v22AssignmentId: assignmentId }),
    count: async () => { liveAttemptReads += 1; return 1; },
    create: async () => { attemptWrites += 1; },
  },
  amuxWorkDelivery: {
    findFirst: async () => scenario === "generic-delivery" ? null :
      ({ attemptId, taskId }),
    create: async () => { deliveryWrites += 1; },
    updateMany: async () => { deliveryWrites += 1; return { count: 1 }; },
  },
  amuxWorkerRuntime: {
    updateMany: async () => { runtimeWrites += 1; return { count: 1 }; },
  },
};

const boundaries = new Proxy({}, { get: () => ({ prismaCallCeiling: 10 }) });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: boundaries,
  AmuxDbBoundaryError: class extends Error {},
  amuxBoundaryWithAttachment: (value: unknown) => value,
  amuxRouteOrchestratorReceiptsMayHaveCommitted: () => false,
  withAmuxDbBoundary: async (_value: unknown,
    work: (client: unknown, context: unknown) => Promise<unknown>) => work(tx, {
      dbNow: now, attachedTransaction: tx, requireLeaseAt: () => undefined,
    }),
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async () => { auditWrites += 1; return "audit-one"; },
} });
mock.module(mod("lib/amux/incident.ts"), { namedExports: {
  lockAmuxAdmissionAndReadIncident: async () => ({ blocks_admission: false }),
} });
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), { namedExports: {
  findOpenAmuxOrchestratorHalt: async () => null,
} });
mock.module(mod("lib/amux/resourcePolicy.ts"), { namedExports: {
  evaluateLockedAmuxCostAdmission: async () => ({ allowed: true }),
  lockAmuxResourcePolicies: async () => [],
} });
mock.module(mod("lib/amux/resourcePolicyCore.ts"), { namedExports: {
  amuxResourceRefs: () => [],
} });
mock.module(mod("lib/amux/v22LegacySafeStopFence.ts"), { namedExports: {
  amuxV22WorkerSafeStopFenced: async () => false,
} });
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  readAmuxV22RecoveryAuthority: async () => recoveryAuthority,
  recoveryAttemptBudget: () => ({ allowed: true, next_attempt_number: 1 }),
} });
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), { namedExports: {
  calculateCurrentApprovedAmuxV4TaskCost: async () => ({
    approvalId: "catalog-one", catalogDigest: receipt.catalogDigest,
    catalog: {}, receipt,
  }),
} });
mock.module(mod("lib/amux/v4TaskCostCeilingCore.ts"), { namedExports: {
  checkV4TaskApprovedCeiling: () => ({ decision: "allow" }),
} });
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: {
  loadAmuxContentKeyRing: async () => ({}),
} });
mock.module(mod("lib/amux/ideaCrypto.ts"), { namedExports: {
  openAmuxContent: () => { decryptCalls += 1; return Buffer.from("brief"); },
  verifyAmuxContentDigest: () => true,
} });
mock.module(mod("lib/engineeringAgentStore.ts"), { namedExports: {
  EngineeringAgentStoreRefusedError: class extends Error {},
  endEngineeringAgentRun: async () => undefined,
  engineeringAgentTransactionInAmux: (value: unknown) => value,
  heartbeatEngineeringAgentRun: async () => undefined,
  lockEngineeringAgentV22Run: async () => null,
  readEngineeringAgentSwitches: async () => ({ publishAllowed: false }),
  recordEngineeringAgentRunStart: async () => undefined,
  requireEngineeringAgentRunAdmission: async () => undefined,
} });
mock.module(mod("lib/engineeringAgentV22SettlementPatch.ts"), { namedExports: {
  loadEngineeringAgentV22SettlementPatch: async () => null,
} });
mock.module(mod("lib/engineeringAgentV22StoredCandidate.ts"), { namedExports: {
  loadEngineeringAgentV22StoredCandidate: async () => null,
} });

const execution = import(mod("lib/amux/execution.ts"));
const delivery = import(mod("lib/amux/delivery.ts"));
const workerRuntime = import(mod("lib/amux/workerRuntime.ts"));

const resetWrites = () => {
  decryptCalls = 0; liveAttemptReads = 0; taskWrites = 0; runtimeWrites = 0;
  attemptWrites = 0; deliveryWrites = 0; auditWrites = 0;
};

test("an API-only runtime cannot start an ordinary assignment", async () => {
  scenario = "start"; runtimeCapabilities = apiCapability;
  recoveryAuthority = null; assignmentRecoveryApprovalId = null; resetWrites();
  const previous = process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "enabled";
  try {
    const result = await (await execution).startAmuxV22TaskExecution({
      taskId, assignmentId, worker, instanceId, generation: 1,
      expectedRevision: 6,
    });
    assert.deepEqual(result,
      { started: false, reason: "recovery_approval_unbound" });
    assert.deepEqual([taskWrites, runtimeWrites, attemptWrites,
      deliveryWrites, auditWrites], [0, 0, 0, 0, 0]);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
    else process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = previous;
  }
});

test("an API-only runtime cannot start a generic ordinary task", async () => {
  scenario = "generic-start"; runtimeCapabilities = apiCapability;
  recoveryAuthority = null; assignmentRecoveryApprovalId = null; resetWrites();
  const result = await (await execution).startAmuxExecution({
    taskId, worker, instanceId, generation: 1, expectedRevision: 6, now,
  });
  assert.deepEqual(result, { started: false, reason: "runtime_not_ready" });
  assert.deepEqual([taskWrites, runtimeWrites, attemptWrites,
    deliveryWrites, auditWrites], [0, 0, 0, 0, 0]);
});

test("an API-only runtime cannot lease a generic ordinary delivery", async () => {
  scenario = "generic-delivery"; runtimeCapabilities = apiCapability;
  recoveryAuthority = null; assignmentRecoveryApprovalId = null; resetWrites();
  await assert.rejects((await delivery).pullAmuxWorkDelivery({
    worker, instanceId, generation: 1, now,
  }), /ordinary delivery cannot use a read-only API runtime/);
  assert.equal(decryptCalls, 0);
  assert.equal(deliveryWrites, 0);
  assert.equal(auditWrites, 0);
});

test("generic ordinary delivery preserves empty and CLI capabilities", async () => {
  for (const capabilities of [[], ["read_only_retry_v1"]]) {
    scenario = "generic-delivery"; runtimeCapabilities = capabilities;
    recoveryAuthority = null; assignmentRecoveryApprovalId = null; resetWrites();
    const result = await (await delivery).pullAmuxWorkDelivery({
      worker, instanceId, generation: 1, now,
    });
    assert.equal(result.available, true);
    if (result.available) {
      assert.equal(result.delivery.prompt, "ordinary prompt");
      assert.equal(result.delivery.v22Execution, null);
    }
    assert.equal(decryptCalls, 0);
    assert.equal(deliveryWrites, 1);
    assert.equal(auditWrites, 1);
  }
});

test("an API-only runtime is refused before ordinary delivery decrypt or lease", async () => {
  scenario = "delivery"; runtimeCapabilities = apiCapability;
  recoveryAuthority = null; assignmentRecoveryApprovalId = null; resetWrites();
  const previous = process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "enabled";
  try {
    await assert.rejects((await delivery).pullAmuxWorkDelivery({
      worker, instanceId, generation: 1, now,
    }), /ordinary delivery cannot use a read-only API runtime/);
    assert.equal(decryptCalls, 0);
    assert.equal(deliveryWrites, 0);
    assert.equal(auditWrites, 0);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
    else process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = previous;
  }
});

test("recovery delivery requires the approved executor capability", async () => {
  scenario = "delivery"; runtimeCapabilities = ["read_only_retry_v1"];
  assignmentRecoveryApprovalId = "approval-one";
  recoveryAuthority = { id: "approval-one", riskAcceptanceId: "risk-one",
    readOnlyExecutorKind: "read_only_api_retry_v1" };
  resetWrites();
  const previous = process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
  process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = "enabled";
  try {
    await assert.rejects((await delivery).pullAmuxWorkDelivery({
      worker, instanceId, generation: 1, now,
    }), /recovery delivery runtime capability is invalid/);
    assert.equal(decryptCalls, 0);
    assert.equal(deliveryWrites, 0);
    assert.equal(auditWrites, 0);
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION;
    else process.env.TOMVERSE_AMUX_V22_TASK_EXECUTION = previous;
  }
});

test("a busy runtime cannot change executor capability during a live attempt", async () => {
  scenario = "heartbeat"; runtimeCapabilities = apiCapability;
  recoveryAuthority = null; assignmentRecoveryApprovalId = null; resetWrites();
  const changed = await (await workerRuntime).heartbeatAmuxWorkerRuntime({
    workerName: worker, instanceId, generation: 1, status: "busy",
    dispatchReady: false, protocolCapabilities: ["read_only_retry_v1"], now,
  });
  assert.equal(changed.accepted, false);
  assert.equal(changed.reason, "active_execution");
  assert.equal(liveAttemptReads, 1);
  assert.equal(runtimeWrites, 0);
  assert.equal(auditWrites, 0);

  const unchanged = await (await workerRuntime).heartbeatAmuxWorkerRuntime({
    workerName: worker, instanceId, generation: 1, status: "busy",
    dispatchReady: false, protocolCapabilities: apiCapability as
      ["read_only_api_retry_v1"], now,
  });
  assert.equal(unchanged.accepted, true);
  assert.equal(liveAttemptReads, 1);
  assert.equal(runtimeWrites, 1);
  assert.equal(auditWrites, 0);
});
