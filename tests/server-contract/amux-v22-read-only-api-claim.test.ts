import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-13T12:00:00.000Z");
const taskId = "task-one";
const workerName = "worker-one";
const receipt = {
  role: "investigate", grade: "high", catalogVersion: "v1",
  catalogDigest: "c".repeat(64), pricingVersion: "price-v1",
  gradeRulesVersion: "grade-v1", caps: {}, ceilingMicroUsd: "3400000",
  receiptDigest: "e".repeat(64),
  routes: [{ routeId: "read-only-route", workerName, provider: "anthropic",
    modelId: "claude-opus-5-5", routePolicyDigest: "d".repeat(64),
    perAttemptMicroUsd: "3400000" }],
};
// An assignment records the prices of the route it reserves against.
const approved = { approvalId: "catalog-one", catalogDigest: receipt.catalogDigest,
  catalog: { pricingVersion: "price-v1", routes: [{ routeId: "read-only-route",
    modelId: "claude-opus-5-5", uncachedInputMicroUsdPerMillion: 1_000_000,
    cacheReadMicroUsdPerMillion: 100_000, cacheWriteMicroUsdPerMillion: 200_000,
    outputMicroUsdPerMillion: 2_000_000 }] }, receipt };
let recovery: Record<string, unknown> | null = null;
let assignmentWrites = 0;
let assignedRoutePrice: unknown = null;
let taskWrites = 0;
let listedCapabilities = ["read_only_api_retry_v1"];
let pinnedCapabilities = ["read_only_api_retry_v1"];
let telemetryWorkers: string[][] = [];

const workers = [workerName, "worker-two", "worker-three"].map((name) => ({
  worker_name: name,
  provider: "anthropic",
  model: name === workerName ? "claude-opus-5-5" : "claude-sonnet-5-5",
  routing_roles: ["investigate"],
  tool_capabilities: ["repo_read"],
  archived: false, paused: false, isolated: false, blocked: false,
}));
const runtime = (name: string, capabilities = name === workerName ?
  listedCapabilities : []) => ({ workerName: name,
  instanceId: `${name}-instance`, generation: 1, status: "idle",
  dispatchReady: true,
  protocolCapabilities: capabilities,
  leaseExpiresAt: new Date("2026-10-13T12:01:00.000Z") });

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("ORDER BY CASE WHEN lane")) return [{ id: taskId }];
    if (sql.includes("FROM \"AmuxWorkItem\" WHERE \"id\"") &&
        sql.includes("FOR UPDATE")) return [{ id: taskId }];
    if (sql.includes("FROM \"AmuxExecutionAttempt\" a")) return [];
    if (sql.includes("FROM \"AmuxWorkerRuntime\"") && sql.includes("FOR UPDATE"))
      return [runtime(workerName, pinnedCapabilities)];
    throw new Error(`unexpected SQL: ${sql}`);
  },
  amuxV22LaneDecision: { findFirst: async () => null },
  amuxWorkItem: {
    findUnique: async () => ({ status: "todo", sourceSystem: "admin-idea-v4",
      cardType: "task", archivedAt: null, owner: null, claimedAt: null,
      revision: 5, taskRole: "investigate", executionGrade: "high",
      v22ReceiptId: "promotion-one", v22AssignmentId: null }),
    findMany: async () => [],
    updateMany: async () => { taskWrites += 1; return { count: 1 }; },
  },
  amuxV22PromotionReceipt: { findUnique: async () => ({ id: "promotion-one",
    workItemId: taskId, sourceApprovalId: "source-one",
    briefDigest: "b".repeat(64) }) },
  amuxWorkerRuntime: { findMany: async () => workers.map((worker) =>
    runtime(worker.worker_name)) },
  amuxV22WorkerAssignment: {
    findMany: async () => [],
    create: async () => { assignmentWrites += 1; },
  },
  amuxIdeaUnitDecision: { findUnique: async () => ({
    confirmationSnapshot: { card: { task: { costReceipt: receipt } } },
  }) },
  amuxExecutionAttempt: { aggregate: async () => ({
    _count: { _all: 1 }, _max: { attemptNumber: 1 },
    _sum: { reservedCostMicrousd: BigInt("3400000") },
  }) },
};

mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (client: unknown) => unknown) => work(tx) },
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async (input: { metadata?: Record<string, unknown> }) => {
    assignedRoutePrice = input.metadata?.routePrice;
    return "assignment-audit";
  },
} });
mock.module(mod("lib/amux/incident.ts"), { namedExports: {
  lockAmuxAdmissionAndReadIncident: async () => ({ blocks_admission: false }),
} });
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), { namedExports: {
  findOpenAmuxOrchestratorHalt: async () => null,
} });
// Orchestration v35, section 3: the v22 claim reads its catalog through the
// assignment catalog reader, the catalog derived from the registry.
mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxAssignmentCatalogs: async () => ({ workers: [], v22: workers, ceilings: null }),
} });
mock.module(mod("lib/amux/telemetry.ts"), { namedExports: {
  getAmuxWorkerTelemetry: async (selected: Array<{ worker_name: string }>) => {
    telemetryWorkers.push(selected.map((worker) => worker.worker_name));
    return new Map([[workerName, {
    evidence: { quota: { state: "fresh" } },
    scoring: { provider_exhausted: false,
      quota_remaining: { value: 1 } },
    }]]);
  },
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
} });
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  readAmuxV22RecoveryAuthority: async () => recovery,
  amuxV22ApiModelAccessCurrent: (authority: Record<string, unknown> | null,
    at: Date) => authority?.readOnlyExecutorKind !== "read_only_api_retry_v1" ||
      Boolean(authority.apiModelAccessEvidence &&
        (authority.apiModelAccessEvidence as { accessState: string }).accessState === "verified" &&
        (authority.apiModelAccessEvidence as { selectedModelId: string }).selectedModelId ===
          authority.modelId &&
        (authority.apiModelAccessEvidence as { canonicalModelId: string }).canonicalModelId ===
          authority.modelId &&
        at.getTime() - (authority.apiModelAccessEvidence as { recordedAt: Date })
          .recordedAt.getTime() <= 90_000),
} });
mock.module(mod("lib/amux/v22LegacySafeStopFence.ts"), { namedExports: {
  amuxV22SafeStopFencedWorkers: async () => new Set(),
} });
mock.module(mod("lib/amux/v4TaskReadyService.ts"), { namedExports: {
  loadAmuxV4TaskReadyContext: async () => ({}),
  evaluateAmuxV4TaskReadyInTransaction: async () => ({ ready: true,
    sourceApprovalId: "source-one", briefDigest: "b".repeat(64) }),
} });

const protocol = import(mod("lib/amux/v22ReadOnlyApiProtocol.mjs"));
const core = import(mod("lib/amux/v22TaskRecoveryCore.ts"));
const service = import(mod("lib/amux/v22WorkerClaimService.ts"));

test("API gate and current frame fence claim before assignment mutation", async () => {
  const p = await protocol;
  const frame = p.parseAmuxV22ReadOnlyApiExecutionFrame({
    version: 1, executorKind: "read_only_api_retry_v1", provider: "anthropic",
    modelId: "claude-opus-5-5", routeId: "read-only-route",
    routePolicyDigest: "d".repeat(64), catalogApprovalId: "catalog-one",
    catalogVersion: "v1", catalogDigest: receipt.catalogDigest,
    pricingVersion: "price-v1", pricingSource: "approved-catalog",
    pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
    pricingExpiresAt: "2026-10-14T00:00:00.000Z",
    uncachedInputMicroUsdPerMillion: 1, cacheReadMicroUsdPerMillion: 1,
    cacheWriteMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1,
    tokenLimits: { uncachedInputTokens: 10, cacheReadTokens: 10,
      cacheWriteTokens: 10, outputTokens: 10 }, maxProviderTurns: 8,
    maxOutputTokensPerTurn: 10, maxRetries: 0, maximumCostMicroUsd: 3_400_000,
    credentialProfileId: "recovery-api-key",
    credentialMetadataDigest: "1".repeat(64),
    executorArtifactDigest: "2".repeat(64),
    settingsDigest: p.AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
    repositoryScopeDigest: "3".repeat(64),
    brokerPolicyDigest: p.AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
    toolSchemaDigest: p.AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  }, { now });
  const c = await core;
  const cost = c.amuxV22ReadOnlyRetryRouteCost({
    priorReservedMicroUsd: BigInt("3400000"),
    catalogApprovalId: approved.approvalId,
    receipt: receipt as never,
    routeId: "read-only-route", workerName,
    provider: "anthropic", modelId: "claude-opus-5-5",
  });
  recovery = { id: "approval-one", taskId, afterRevision: 5,
    historicalAttempts: 1, nextAttemptNumber: 2,
    oldHeldMicroUsd: BigInt("3400000"), additionalCapMicroUsd: BigInt("3400000"),
    catalogApprovalId: "catalog-one", costDigest: cost.costDigest,
    riskAcceptanceId: "risk-one", priorAttemptId: "prior-one",
    readOnlyExecutorKind: "read_only_api_retry_v1", apiExecutionFrame: frame,
    workerName, provider: "anthropic", modelId: "claude-opus-5-5",
    routeId: "read-only-route", routePolicyDigest: "d".repeat(64),
    briefDigest: "b".repeat(64) };
  const env = {
    TOMVERSE_AMUX_V22_WORKER_CLAIM: process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM,
    TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED:
      process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED,
    TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID:
      process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID,
    TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST:
      process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST,
    TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST:
      process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST,
    TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST:
      process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST,
  };
  process.env.TOMVERSE_AMUX_V22_WORKER_CLAIM = "enabled";
  process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID =
    frame.credentialProfileId;
  process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST =
    frame.credentialMetadataDigest;
  process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST =
    frame.executorArtifactDigest;
  process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST =
    frame.repositoryScopeDigest;
  try {
    delete process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED;
    const off = await (await service).tickV22WorkerClaim();
    assert.deepEqual(off, { claimed: false, reason: "no_ready_candidate" });
    assert.equal(assignmentWrites, 0);
    assert.equal(taskWrites, 0);

    process.env.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED = "true";
    const approvedRecovery = recovery;
    recovery = null;
    const noAuthority = await (await service).tickV22WorkerClaim();
    assert.deepEqual(noAuthority, { claimed: false, reason: "no_ready_candidate" });
    assert.equal(assignmentWrites, 0);
    assert.equal(taskWrites, 0);

    listedCapabilities = [];
    const changedWhilePinned = await (await service).tickV22WorkerClaim();
    assert.deepEqual(changedWhilePinned,
      { claimed: false, reason: "no_ready_candidate" });
    assert.equal(assignmentWrites, 0);
    assert.equal(taskWrites, 0);

    for (const capabilities of [[], ["read_only_retry_v1"]]) {
      listedCapabilities = capabilities;
      pinnedCapabilities = capabilities;
      const ordinary = await (await service).tickV22WorkerClaim();
      assert.equal(ordinary.claimed, true, JSON.stringify(capabilities));
      assert.equal(assignmentWrites, 1);
      assert.equal(taskWrites, 1);
      assignmentWrites = 0;
      taskWrites = 0;
    }

    recovery = approvedRecovery;
    listedCapabilities = ["read_only_api_retry_v1"];
    pinnedCapabilities = ["read_only_api_retry_v1"];
    telemetryWorkers = [];
    const noAccessEvidence = await (await service).tickV22WorkerClaim();
    assert.deepEqual(noAccessEvidence,
      { claimed: false, reason: "no_ready_candidate" });
    assert.equal(assignmentWrites, 0);
    assert.equal(taskWrites, 0);
    assert.deepEqual(telemetryWorkers.at(-1), [],
      "an API-key worker must never consume CLI quota telemetry");

    recovery = { ...approvedRecovery, apiModelAccessEvidence: {
      accessState: "verified", balanceKnown: false,
      selectedModelId: "claude-opus-5-5", canonicalModelId: "claude-opus-5-5",
      recordedAt: new Date("2026-10-13T11:59:30.000Z"),
    } };
    const on = await (await service).tickV22WorkerClaim();
    assert.equal(on.claimed, true);
    assert.equal(on.workerName, workerName);
    assert.equal(assignmentWrites, 1);
    assert.equal(taskWrites, 1);
    assert.deepEqual(assignedRoutePrice, { pricingVersion: "price-v1",
      modelId: "claude-opus-5-5", uncachedInputMicroUsdPerMillion: 1_000_000,
      cacheReadMicroUsdPerMillion: 100_000, cacheWriteMicroUsdPerMillion: 200_000,
      outputMicroUsdPerMillion: 2_000_000 }, "the assignment records the price it reserves against");
  } finally {
    listedCapabilities = ["read_only_api_retry_v1"];
    pinnedCapabilities = ["read_only_api_retry_v1"];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
