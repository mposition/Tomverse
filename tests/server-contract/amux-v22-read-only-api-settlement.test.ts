import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-13T12:00:00.000Z");
const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
const attemptId = "00000000-0000-4000-8000-000000000003";
const worker = "worker-one";
const instanceId = "instance-one";
const catalogDigest = "c".repeat(64);

type Outcome = "succeeded" | "failed";
type World = ReturnType<typeof makeWorld>;
let world: World;

function makeWorld(outcome: Outcome) {
  return {
    outcome,
    taskId,
    attemptId,
    attemptNumber: 2,
    recoveryApprovalId: "approval-one" as string | null,
    frame: null as unknown,
    recovery: null as unknown,
    storedEvents: [] as Array<Record<string, unknown>>,
    usageRows: [] as Array<{ receiptDigest: string }>,
    usageInserts: 0,
    usageAudits: 0,
    settlementAudits: 0,
    gradeEscalationAudits: [] as Array<Record<string, unknown>>,
    gradeGuard: false,
    frontierPriceAvailable: true,
    frontierPriceDatabaseError: false,
    taskRole: null as string | null,
    taskGrade: "medium",
    assignmentGrade: null as string | null,
    assignmentRole: "investigate",
    reviewVerdict: null as "accept" | "reject" | "unknown" | null,
    priorReviewRejections: 0,
    reviewAuditCount: 0,
    reviewCreated: null as Record<string, unknown> | null,
    assignmentAuditPresent: true,
    assignmentAuditAction: "amux.v22.worker.assigned",
    sourceApprovalId: null as string | null,
    patch: null as { taskId: string; baseSha: string; sha256: string;
      text: string; files: Array<{ path: string; mode: "100644";
        bytesBase64: string }> | null } | null,
    taskUpdates: 0,
    gradeAuditsAtTaskUpdate: -1,
    attemptUpdates: 0,
    runtimeUpdates: 0,
    taskUpdateData: null as Record<string, unknown> | null,
    attemptUpdateData: null as Record<string, unknown> | null,
  };
}

const boundary = new Proxy({}, {
  get: () => ({ prismaCallCeiling: 1 }),
});

mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: boundary,
  AmuxDbBoundaryError: class AmuxDbBoundaryError extends Error {},
  amuxBoundaryWithAttachment: (value: unknown) => value,
  amuxRouteOrchestratorReceiptsMayHaveCommitted: () => false,
  withAmuxDbBoundary: async (_value: unknown,
    work: (tx: unknown, context: unknown) => Promise<unknown>) => work(tx, {
      dbNow: now,
      attachedTransaction: tx,
      requireLeaseAt: () => undefined,
    }),
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async (input: { action: string }) => {
    if (input.action === "amux.cli_usage.recorded") world.usageAudits += 1;
    if (input.action === "amux.v22.execution.settled")
      world.settlementAudits += 1;
    if (input.action === "amux.grade.escalated")
      world.gradeEscalationAudits.push(input as unknown as Record<string, unknown>);
    if (input.action === "amux.review.recorded") world.reviewAuditCount += 1;
    return `audit-${input.action}`;
  },
} });
mock.module(mod("lib/amux/delivery.ts"), { namedExports: {
  cancelPendingAmuxWorkDelivery: async () => undefined,
} });
mock.module(mod("lib/amux/escalation.ts"), { namedExports: {
  openAmuxHumanEscalation: async () => undefined,
} });
mock.module(mod("lib/engineeringAgentV22SettlementPatch.ts"), {
  namedExports: { loadEngineeringAgentV22SettlementPatch: async () => world.patch },
});
mock.module(mod("lib/engineeringAgentV22StoredCandidate.ts"), {
  namedExports: { loadEngineeringAgentV22StoredCandidate: async () => null },
});
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
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  readAmuxV22RecoveryAuthority: async () => world.recovery,
  amuxV22ApiModelAccessCurrent: () => true,
  recoveryAttemptBudget: async () => ({ allowed: false }),
} });
class CatalogApprovalError extends Error {}
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), {
  namedExports: {
    AmuxV4TaskCatalogApprovalError: CatalogApprovalError,
    calculateCurrentApprovedAmuxV4TaskCost: async () => {
      if (world.frontierPriceDatabaseError) throw new Error("database unavailable");
      if (!world.frontierPriceAvailable) throw new CatalogApprovalError("price unavailable");
      return { receipt: { role: "implement", grade: "frontier",
        receiptDigest: "f".repeat(64) } };
    },
    // Task prices come from the registries (owner decision 2026-10-25).
    readAmuxV4TaskAutoCatalog: async () => ({ ok: true, catalogDigest,
      catalogId: "registry:one", catalog: { pricingVersion: "price-v1",
        routes: [{ enabled: true, workerName: worker,
          provider: "anthropic", modelId: "claude-opus-5-5",
          pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
          pricingExpiresAt: "2026-10-14T00:00:00.000Z",
          uncachedInputMicroUsdPerMillion: 1_000_000,
          cacheReadMicroUsdPerMillion: 100_000,
          cacheWriteMicroUsdPerMillion: 200_000,
          outputMicroUsdPerMillion: 2_000_000 }] } }),
  },
});
mock.module(mod("lib/amux/v52GradeReceipt.ts"), { namedExports: {
  AMUX_GRADE_ESCALATED_ACTION: "amux.grade.escalated",
  readAmuxV52TaskReceipt: async () => ({ role: "implement",
    grade: "routine", receiptDigest: "a".repeat(64) }),
} });
mock.module(mod("lib/amux/v4TaskCostCatalogCore.ts"), { namedExports: {
  inspectV4TaskCostCatalog: () => ({ ok: true, catalogDigest }),
} });

const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes('FROM "AmuxWorkerRuntime"')) return [{
      workerName: worker, instanceId, generation: 1, status: "busy",
      dispatchReady: false, protocolCapabilities: ["read_only_api_retry_v1"],
      leaseExpiresAt: new Date("2026-10-13T12:01:00.000Z"),
    }];
    if (sql.includes('FROM "AmuxExecutionAttempt"')) return [{
      id: world.attemptId, taskId: world.taskId, worker,
      workerInstanceId: instanceId,
      workerGeneration: 1, taskRevision: 5,
      attemptNumber: world.attemptNumber,
      reservedCostMicrousd: BigInt("3400000"), v22AssignmentId: "assignment-one",
      startedAt: new Date("2026-10-13T11:59:00.000Z"),
      leaseExpiresAt: new Date("2026-10-13T12:01:00.000Z"), endedAt: null,
    }];
    if (sql.includes('FROM "AmuxWorkItem"')) return [{
      id: world.taskId, sourceSystem: "admin-idea-v4", cardType: "task",
      taskRole: world.taskRole, executionGrade: world.taskGrade,
      v4SourceApprovalId: world.sourceApprovalId,
      v22AssignmentId: "assignment-one", owner: worker, status: "doing",
      revision: 5, claimedAt: new Date("2026-10-13T11:59:00.000Z"),
      archivedAt: null, projectKey: null, teamKey: null,
      estimatedCostMicrousd: BigInt("3400000"), requiresHumanReview: true,
      reviewSpecialty: null, executionBrief: "sealed",
      executionBriefDigest: "b".repeat(64),
    }];
    if (sql.includes('INSERT INTO "AmuxCliUsageEvent"')) {
      world.usageInserts += 1;
      world.usageRows.push({ receiptDigest: String(values[2]) });
      return [{ id: "usage-one" }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
  amuxV22WorkerAssignment: { findUnique: async () => ({
    id: "assignment-one", grade: world.assignmentGrade ?? world.taskGrade,
    role: world.assignmentRole, provider: "anthropic",
    authorizationAuditLogId: "assignment-audit",
    recoveryApprovalId: world.recoveryApprovalId, taskRevision: 5,
  }) },
  amuxWorkDelivery: { findUnique: async () => ({ status: "acknowledged" }) },
  amuxCliUsageEvent: {
    findMany: async () => world.storedEvents,
    findUnique: async () => null,
  },
  amuxV22TaskResult: { findUnique: async () => world.outcome === "succeeded" ?
    { taskId: world.taskId, bodyPurgedAt: null } : null },
  amuxV22TaskPatch: { findUnique: async () => world.patch ? {
    taskId: world.patch.taskId, baseSha: world.patch.baseSha,
    patchSha256: world.patch.sha256, bodyPurgedAt: null,
  } : null },
  amuxV52ReviewRecord: {
    findUnique: async () => world.reviewCreated ?? (world.reviewVerdict ? {
      jobId: "r-20261016-110000-abcdef", baseSha: world.patch?.baseSha,
      verdict: world.reviewVerdict, authorVendor: "anthropic",
      auditLog: { entryHash: "a".repeat(64) },
    } : null),
    count: async () => world.priorReviewRejections,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      world.reviewCreated = data;
      return data;
    },
  },
  amuxIdeaUnitDecision: { findUnique: async () => ({
    confirmationSnapshot: { card: { task: { costReceipt: {
      role: "implement", grade: "routine", receiptDigest: "a".repeat(64),
    } } } },
  }) },
  engineeringAgentWorkItem: { findFirst: async () => null },
  amuxWorkItem: { update: async (input: { data: Record<string, unknown> }) => {
    world.taskUpdates += 1;
    world.gradeAuditsAtTaskUpdate = world.gradeEscalationAudits.length;
    world.taskUpdateData = input.data;
  } },
  amuxExecutionAttempt: {
    findUnique: async () => ({
      taskId: world.taskId, worker,
      taskRevision: 5,
      startedAt: new Date("2026-10-13T11:59:00.000Z"),
      endedAt: null, v22AssignmentId: "assignment-one",
      v22Assignment: { recoveryApprovalId: world.recoveryApprovalId },
      task: { sourceSystem: "admin-idea-v4",
        v22AssignmentId: "assignment-one",
        v22AcceptedAssignment: { workerName: worker, provider: "anthropic",
          modelId: "claude-opus-5-5" } },
    }),
    update: async (input: { data: Record<string, unknown> }) => {
      world.attemptUpdates += 1;
      world.attemptUpdateData = input.data;
    },
  },
  amuxWorkerRuntime: {
    updateMany: async () => { world.runtimeUpdates += 1; return { count: 1 }; },
  },
  adminAuditLog: { findUnique: async (args: { where: { id: string } }) =>
    args.where.id === "assignment-audit" ?
      !world.assignmentAuditPresent ? null : {
      entryHash: "a".repeat(64), action: world.assignmentAuditAction,
      targetId: "assignment-one", metadata: { v52GradeRouting: world.gradeGuard },
    } : args.where.id === "audit-amux.review.recorded" ? {
      entryHash: "a".repeat(64), action: "amux.review.recorded",
      targetId: world.taskId,
    } : { entryHash: "a".repeat(64),
      action: "amux.v4.task_catalog.approve", actorUserId: "owner-one",
      targetId: "catalog-one", targetType: "AmuxV4TaskCostCatalogApproval" } },
};

const protocol = import(mod("lib/amux/v22ReadOnlyApiProtocol.mjs"));
const store = import(mod("lib/amux/cliUsageLedgerStore.ts"));
const execution = import(mod("lib/amux/execution.ts"));

async function settlementInput(outcome: Outcome) {
  const p = await protocol;
  const frame = p.parseAmuxV22ReadOnlyApiExecutionFrame({
    version: 1, executorKind: "read_only_api_retry_v1", provider: "anthropic",
    modelId: "claude-opus-5-5", routeId: "read-only-route",
    routePolicyDigest: "d".repeat(64), catalogApprovalId: "catalog-one",
    catalogVersion: "v1", catalogDigest, pricingVersion: "price-v1",
    pricingSource: "approved-catalog",
    pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
    pricingExpiresAt: "2026-10-14T00:00:00.000Z",
    uncachedInputMicroUsdPerMillion: 1_000_000,
    cacheReadMicroUsdPerMillion: 100_000,
    cacheWriteMicroUsdPerMillion: 200_000,
    outputMicroUsdPerMillion: 2_000_000,
    tokenLimits: { uncachedInputTokens: 10, cacheReadTokens: 10,
      cacheWriteTokens: 10, outputTokens: 10 }, maxProviderTurns: 8,
    maxOutputTokensPerTurn: 10, maxRetries: 0,
    maximumCostMicroUsd: 3_400_000,
    credentialProfileId: "recovery-api-key",
    credentialMetadataDigest: "1".repeat(64),
    executorArtifactDigest: "2".repeat(64),
    settingsDigest: p.AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
    repositoryScopeDigest: "3".repeat(64),
    brokerPolicyDigest: p.AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
    toolSchemaDigest: p.AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  }, { now });
  const frameDigest = p.amuxV22ReadOnlyApiExecutionFrameDigest(frame);
  const body = { version: 1, executorKind: "read_only_api_retry_v1",
    attemptId, invocationId: attemptId, selectedModelId: frame.modelId,
    actualModelId: frame.modelId, actualModelUniform: true,
    providerTurnCount: 2, uncachedInputTokens: 3, cacheReadTokens: 4,
    cacheWriteTokens: 5, outputTokens: 6, usageComplete: true,
    terminalStatus: outcome, apiExecutionFrameDigest: frameDigest,
    projectedCostMicroUsd: p.projectAmuxV22ReadOnlyApiCost(frame, {
      uncachedInputTokens: 3, cacheReadTokens: 4,
      cacheWriteTokens: 5, outputTokens: 6,
    }),
  } as const;
  const receipt = p.parseAmuxV22ReadOnlyApiExecutionReceipt({ ...body,
    digest: p.amuxV22ReadOnlyApiExecutionReceiptDigest(body) }, frame);
  world.frame = frame;
  world.recovery = { riskAcceptanceId: "risk-one",
    launchBindingId: "binding-one", launchProofDigest: "4".repeat(64),
    launchScopeDigest: "5".repeat(64),
    launcherConfigDigest: "6".repeat(64),
    readOnlyExecutorKind: "read_only_api_retry_v1",
    apiExecutionFrame: frame };
  return { attemptId, worker, instanceId, generation: 1, taskRevision: 5,
    outcome, invocationIds: [attemptId], readOnlyRetry: {
      version: 1 as const, launchBindingId: "binding-one",
      launchProofDigest: "4".repeat(64), launchScopeDigest: "5".repeat(64),
      executorKind: "read_only_api_retry_v1" as const,
      launcherConfigDigest: "6".repeat(64),
      apiExecutionFrameDigest: frameDigest, apiExecutionReceipt: receipt,
    } };
}

for (const outcome of ["succeeded", "failed"] as const) {
  test(`native API ${outcome} settlement writes one usage row and usage audit`,
    async () => {
      world = makeWorld(outcome);
      const input = await settlementInput(outcome);
      const result = await (await execution).settleAmuxV22TaskExecution(input);
      assert.equal(result.settled, true);
      assert.equal(world.usageInserts, 1);
      assert.equal(world.usageAudits, 1);
      assert.equal(world.settlementAudits, 1);
      assert.equal(world.usageRows[0]?.receiptDigest,
        input.readOnlyRetry.apiExecutionReceipt.digest);
      assert.equal(world.taskUpdates, 1);
      assert.equal(world.attemptUpdates, 1);
      assert.equal(world.runtimeUpdates, 1);
      assert.equal(world.taskUpdateData?.status,
        outcome === "failed" ? "blocked" : "review");
      assert.equal(world.attemptUpdateData?.toStatus,
        outcome === "failed" ? "blocked" : "review");
      assert.equal(world.attemptUpdateData?.reason,
        outcome === "failed" ? "attempts" : "reported_result");
    });
}

test("other Tasks keep the global five-attempt settlement budget", async () => {
  const cases = [[4, "todo", null], [4, "todo", "approval-other"],
    [5, "blocked", null]] as const;
  for (const [attemptNumber, expectedStatus, approvalId] of cases) {
    world = makeWorld("failed");
    world.taskId = "00000000-0000-4000-8000-000000000099";
    world.attemptId = `00000000-0000-4000-8000-00000000000${attemptNumber}`;
    world.attemptNumber = attemptNumber;
    world.recoveryApprovalId = approvalId;
    world.recovery = approvalId ? { riskAcceptanceId: null } : null;
    world.storedEvents = [{ invocationId: world.attemptId,
      receiptDigest: "7".repeat(64), status: "failed",
      completeness: "reported_complete",
      projectedApiCostMicrousd: BigInt(1), cli: "claude",
      source: "claude_result", actualModelId: "claude-opus-5-5",
      selectedModelId: "claude-opus-5-5", provider: "anthropic",
      authentication: "subscription", inputTokens: BigInt(1),
      outputTokens: BigInt(1), cacheReadInputTokens: BigInt(0),
      cacheCreationInputTokens: BigInt(0), inputTokensIncludeCacheRead: false,
      inputTokensIncludeCacheWrite: false, completedTurns: 1,
      pricingVersion: null }];
    const result = await (await execution).settleAmuxV22TaskExecution({
      attemptId: world.attemptId, worker, instanceId, generation: 1,
      taskRevision: 5, outcome: "failed", invocationIds: [world.attemptId],
    });
    assert.equal(result.settled, true);
    assert.equal(world.taskUpdateData?.status, expectedStatus);
    assert.equal(world.attemptUpdateData?.toStatus, expectedStatus);
    assert.equal(world.attemptUpdateData?.reason,
      attemptNumber === 5 ? "attempts" : "reported_result");
  }
});

test("legacy settlement does not acquire the v52 assignment-audit gate", async () => {
  world = makeWorld("succeeded");
  world.assignmentAuditPresent = false;
  world.taskGrade = "routine";
  const result = await (await execution).settleAmuxV22TaskExecution(
    await settlementInput("succeeded"));
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "review");
});

test("v52 settlement refuses a marked but invalid assignment audit", async () => {
  world = makeWorld("succeeded");
  world.gradeGuard = true;
  world.taskGrade = "advanced";
  world.assignmentAuditAction = "unexpected";
  const result = await (await execution).settleAmuxV22TaskExecution(
    await settlementInput("succeeded"));
  assert.deepEqual(result, { settled: false,
    reason: "assignment_audit_unverified" });
});

test("v52 contract touch discards the ordinary grade and binds one frontier receipt", async () => {
  world = makeWorld("failed");
  world.taskId = "00000000-0000-4000-8000-000000000099";
  world.attemptNumber = 1;
  world.recoveryApprovalId = null;
  world.gradeGuard = true;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.sourceApprovalId = "source-one";
  world.storedEvents = [{ invocationId: world.attemptId,
    receiptDigest: "7".repeat(64), status: "failed",
    completeness: "reported_complete", projectedApiCostMicrousd: BigInt(1),
    cli: "claude", source: "claude_result", actualModelId: "claude-opus-5-5",
    selectedModelId: "claude-opus-5-5", provider: "anthropic",
    authentication: "subscription", inputTokens: BigInt(1),
    outputTokens: BigInt(1), cacheReadInputTokens: BigInt(0),
    cacheCreationInputTokens: BigInt(0), inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false, completedTurns: 1,
    pricingVersion: null }];
  const result = await (await execution).settleAmuxV22TaskExecution({
    attemptId: world.attemptId, worker, instanceId, generation: 1,
    taskRevision: 5, outcome: "failed", invocationIds: [world.attemptId],
    changedPaths: ["LIB/AMUX/execution.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  assert.equal(world.taskUpdateData?.status, "todo");
  assert.equal(world.taskUpdateData?.executionGrade, "frontier");
  assert.equal(world.attemptUpdateData?.reason, "contract_path_touched");
  assert.equal(world.gradeEscalationAudits.length, 1);
  assert.equal(world.gradeAuditsAtTaskUpdate, 1);
  assert.deepEqual({ ...(world.gradeEscalationAudits[0]?.metadata as
    Record<string, unknown>), newReceipt: null }, {
    attemptId: world.attemptId, assignmentId: "assignment-one",
    fromRevision: 5, reason: "contract_path_touched",
    previousGrade: "routine", nextGrade: "frontier",
    originalReceiptDigest: "a".repeat(64), newReceipt: null,
    classificationFailure: true,
  });
});

test("v52 settlement blocks a contract publish file omitted from the runner inventory", async () => {
  world = makeWorld("succeeded");
  world.taskId = "00000000-0000-4000-8000-000000000099";
  world.recoveryApprovalId = null;
  world.gradeGuard = true;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.sourceApprovalId = "source-one";
  world.patch = { taskId: world.taskId, baseSha: "b".repeat(40),
    sha256: "d".repeat(64), text: "diff --git a/lib/amux/guard.ts b/lib/amux/guard.ts\n",
    files: [{ path: "lib/amux/guard.ts", mode: "100644",
      bytesBase64: "Y29udHJhY3Q=" }] };
  world.storedEvents = [{ invocationId: world.attemptId,
    receiptDigest: "7".repeat(64), status: "succeeded",
    completeness: "reported_complete", projectedApiCostMicrousd: BigInt(1),
    cli: "claude", source: "claude_result", actualModelId: "claude-opus-5-5",
    selectedModelId: "claude-opus-5-5", provider: "anthropic",
    authentication: "subscription", inputTokens: BigInt(1),
    outputTokens: BigInt(1), cacheReadInputTokens: BigInt(0),
    cacheCreationInputTokens: BigInt(0), inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false, completedTurns: 1,
    pricingVersion: null }];
  const result = await (await execution).settleAmuxV22TaskExecution({
    attemptId: world.attemptId, worker, instanceId, generation: 1,
    taskRevision: 5, outcome: "succeeded", invocationIds: [world.attemptId],
    changedPaths: ["src/ordinary.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.taskUpdateData?.executionGrade, undefined);
  assert.equal(world.attemptUpdateData?.reason, "changed_paths_unavailable");
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("v52 review reject retries once at the same grade, then blocks", async () => {
  for (const [prior, expected, reason] of [
    [0, "todo", "review_server_rejected"],
    [1, "blocked", "review_server_rejected_twice"],
  ] as const) {
    world = makeWorld("succeeded");
    world.attemptNumber = 1;
    world.gradeGuard = true;
    world.assignmentRole = "implement";
    world.taskGrade = "advanced";
    world.reviewVerdict = "reject";
    world.priorReviewRejections = prior;
    world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
      sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
      files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
    const input = await settlementInput("succeeded");
    const result = await (await execution).settleAmuxV22TaskExecution({
      ...input, changedPaths: ["lib/ordinary.ts"],
    });
    assert.equal(result.settled, true);
    assert.equal(world.taskUpdateData?.status, expected);
    assert.equal(world.attemptUpdateData?.reason, reason);
    assert.equal(world.taskUpdateData?.executionGrade, undefined,
      "review rejection cannot escalate grade");
  }
});

test("v52 review record binds an implement patch, assignment and audit once", async () => {
  const previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "v52-review-test-key".repeat(4);
  try {
  world = makeWorld("succeeded");
  world.gradeGuard = true;
  world.assignmentRole = "implement";
  world.taskGrade = "advanced";
  world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
    sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
    files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
  const input = { attemptId, worker, instanceId, generation: 1,
    taskRevision: 5, changedPaths: ["lib/ordinary.ts"], evidence: {
      jobId: "r-20261016-110000-abcdef", baseSha: "a".repeat(40),
      commitSha: "c".repeat(40), verdict: "accept" as const,
      authorVendor: "anthropic", reviewerVendors: ["openai"],
      touchesContract: false,
    } };
  const first = await (await execution).recordAmuxV52Review(input);
  assert.deepEqual(first, { recorded: true, duplicate: false });
  assert.equal(world.reviewAuditCount, 1);
  assert.equal(world.reviewCreated?.attemptId, attemptId);
  const second = await (await execution).recordAmuxV52Review(input);
  assert.deepEqual(second, { recorded: true, duplicate: true });
  assert.equal(world.reviewAuditCount, 1);
  const mismatch = await (await execution).recordAmuxV52Review({
    ...input, evidence: { ...input.evidence, touchesContract: true,
      reviewerVendors: ["openai", "xai"] },
  });
  assert.deepEqual(mismatch, { recorded: false,
    reason: "review_patch_unverified" });
  const incomplete = await (await execution).recordAmuxV52Review({
    ...input, changedPaths: ["app/page.tsx"],
  });
  assert.deepEqual(incomplete, { recorded: false,
    reason: "review_patch_unverified" });
  world = makeWorld("succeeded");
  world.gradeGuard = true;
  world.assignmentRole = "implement";
  world.taskGrade = "frontier";
  world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
    sha256: "b".repeat(64),
    text: "diff --git a/lib/amux/execution.ts b/lib/amux/execution.ts\n",
    files: null };
  const largePatch = await (await execution).recordAmuxV52Review({
    ...input, changedPaths: ["lib/amux/execution.ts"],
    evidence: { ...input.evidence, touchesContract: true,
      reviewerVendors: ["openai", "xai"] },
  });
  assert.deepEqual(largePatch, { recorded: true, duplicate: false });
  } finally {
    if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
  }
});

test("v52 review unknown blocks without another attempt", async () => {
  world = makeWorld("succeeded");
  world.attemptNumber = 1;
  world.gradeGuard = true;
  world.assignmentRole = "implement";
  world.taskGrade = "advanced";
  world.reviewVerdict = "unknown";
  world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
    sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
    files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
  const input = await settlementInput("succeeded");
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...input, changedPaths: ["lib/ordinary.ts"],
  });
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.attemptUpdateData?.reason, "review_server_unknown");
});

test("v52 contract touch on the final attempt blocks for human recovery", async () => {
  world = makeWorld("failed");
  world.taskId = "00000000-0000-4000-8000-000000000099";
  world.attemptNumber = 5;
  world.recoveryApprovalId = null;
  world.gradeGuard = true;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.sourceApprovalId = "source-one";
  world.storedEvents = [{ invocationId: world.attemptId,
    receiptDigest: "7".repeat(64), status: "failed",
    completeness: "reported_complete", projectedApiCostMicrousd: BigInt(1),
    cli: "claude", source: "claude_result", actualModelId: "claude-opus-5-5",
    selectedModelId: "claude-opus-5-5", provider: "anthropic",
    authentication: "subscription", inputTokens: BigInt(1),
    outputTokens: BigInt(1), cacheReadInputTokens: BigInt(0),
    cacheCreationInputTokens: BigInt(0), inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false, completedTurns: 1,
    pricingVersion: null }];
  const result = await (await execution).settleAmuxV22TaskExecution({
    attemptId: world.attemptId, worker, instanceId, generation: 1,
    taskRevision: 5, outcome: "failed", invocationIds: [world.attemptId],
    changedPaths: ["lib/amux/execution.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.taskUpdateData?.executionGrade, undefined);
  assert.equal(world.attemptUpdateData?.reason, "attempt_budget_exhausted");
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("v52 missing inventory blocks even a successful execution", async () => {
  world = makeWorld("succeeded");
  world.gradeGuard = true;
  world.taskGrade = "advanced";
  const result = await (await execution).settleAmuxV22TaskExecution(
    await settlementInput("succeeded"));
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.attemptUpdateData?.reason, "changed_paths_unavailable");
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("v52 worker-blocked outcome keeps its cause without an inventory", async () => {
  world = makeWorld("failed");
  world.gradeGuard = true;
  world.taskGrade = "routine";
  const result = await (await execution).settleAmuxV22TaskExecution({
    attemptId: world.attemptId, worker, instanceId, generation: 1,
    taskRevision: 5, outcome: "blocked", invocationIds: [],
  });
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.notEqual(world.attemptUpdateData?.reason, "changed_paths_unavailable");
});

test("worker-blocked outcome preserves owner retry eligibility with and without v52", async () => {
  for (const gradeGuard of [false, true]) {
    world = makeWorld("failed");
    world.gradeGuard = gradeGuard;
    world.taskGrade = "routine";
    world.storedEvents = [{ invocationId: world.attemptId,
      receiptDigest: "7".repeat(64), status: "failed",
      completeness: "reported_complete", projectedApiCostMicrousd: BigInt(1),
      cli: "claude", source: "claude_result", actualModelId: "claude-opus-5-5",
      selectedModelId: "claude-opus-5-5", provider: "anthropic",
      authentication: "subscription", inputTokens: BigInt(1),
      outputTokens: BigInt(1), cacheReadInputTokens: BigInt(0),
      cacheCreationInputTokens: BigInt(0), inputTokensIncludeCacheRead: false,
      inputTokensIncludeCacheWrite: false, completedTurns: 1,
      pricingVersion: null }];
    const result = await (await execution).settleAmuxV22TaskExecution({
      attemptId: world.attemptId, worker, instanceId, generation: 1,
      taskRevision: 5, outcome: "blocked", invocationIds: [world.attemptId],
      ...(gradeGuard ? { changedPaths: ["app/page.tsx"] } : {}),
    });
    assert.equal(result.settled, true);
    assert.equal(world.taskUpdateData?.status, "blocked");
    assert.equal(world.attemptUpdateData?.reason, "reported_result");
    const { amuxV22ReviewRetryHasVerifiedOutcome } =
      await import(mod("lib/amux/reviewApprovalCore.ts"));
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
      sourceSystem: "admin-idea-v4",
      attempt: { v22AssignmentId: "assignment-one", outcome: "blocked",
        toStatus: "blocked", reason: String(world.attemptUpdateData?.reason) },
    }), true);
  }
});

test("v52 ordinary paths preserve the normal successful destination", async () => {
  world = makeWorld("succeeded");
  world.gradeGuard = true;
  world.taskGrade = "advanced";
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("succeeded"), changedPaths: ["app/page.tsx"],
  });
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "review");
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("v52 contract touch blocks when a new frontier price is unavailable", async () => {
  world = makeWorld("failed");
  world.gradeGuard = true;
  world.frontierPriceAvailable = false;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.sourceApprovalId = "source-one";
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("failed"),
    changedPaths: ["lib/amux/execution.ts"],
  });
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.taskUpdateData?.executionGrade, undefined);
  assert.equal(world.attemptUpdateData?.reason, "grade_receipt_unavailable");
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("v52 frontier price database error cannot be swallowed inside a transaction", async () => {
  world = makeWorld("failed");
  world.gradeGuard = true;
  world.frontierPriceDatabaseError = true;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.sourceApprovalId = "source-one";
  await assert.rejects((await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("failed"),
    changedPaths: ["lib/amux/execution.ts"],
  }), /database unavailable/);
  assert.equal(world.taskUpdateData, null);
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("v52 contract touch reports a task-assignment grade mismatch", async () => {
  world = makeWorld("failed");
  world.gradeGuard = true;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.assignmentGrade = "advanced";
  world.sourceApprovalId = "source-one";
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("failed"),
    changedPaths: ["lib/amux/execution.ts"],
  });
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.attemptUpdateData?.reason, "grade_binding_unverified");
  assert.equal(world.gradeEscalationAudits.length, 0);
});

test("unknown or incomplete native receipt writes no usage or settlement", async () => {
  for (const invalid of [
    { terminalStatus: "outcome_unknown" },
    { usageComplete: false },
  ]) {
    world = makeWorld("failed");
    const input = await settlementInput("failed");
    const receipt = { ...input.readOnlyRetry.apiExecutionReceipt, ...invalid };
    const result = await (await execution).settleAmuxV22TaskExecution({
      ...input, readOnlyRetry: { ...input.readOnlyRetry,
        apiExecutionReceipt: receipt },
    });
    assert.deepEqual(result, { settled: false,
      reason: "read_only_api_receipt_unverified" });
    assert.equal(world.usageInserts, 0);
    assert.equal(world.usageAudits, 0);
    assert.equal(world.settlementAudits, 0);
    assert.equal(world.taskUpdates, 0);
    assert.equal(world.attemptUpdates, 0);
  }
});

test("settlement replay accepts only the stored native receipt digest", async () => {
  for (const exact of [false, true]) {
    world = makeWorld("succeeded");
    const input = await settlementInput("succeeded");
    const projection = (await store).amuxV22ReadOnlyApiUsageProjection({
      frame: world.frame as never,
      receipt: input.readOnlyRetry.apiExecutionReceipt as never,
    });
    world.storedEvents = [{ ...projection,
      receiptDigest: exact ? projection.receiptDigest : "b".repeat(64) }];
    const result = await (await execution).settleAmuxV22TaskExecution(input);
    if (exact) {
      assert.equal(result.settled, true);
      assert.equal(world.usageInserts, 0);
      assert.equal(world.usageAudits, 0);
      assert.equal(world.settlementAudits, 1);
      assert.equal(world.taskUpdates, 1);
    } else {
      assert.deepEqual(result, { settled: false, reason: "usage_unverified" });
      assert.equal(world.usageInserts, 0);
      assert.equal(world.usageAudits, 0);
      assert.equal(world.settlementAudits, 0);
      assert.equal(world.taskUpdates, 0);
    }
  }
});
