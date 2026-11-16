import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import { randomBytes } from "node:crypto";

import { v22PatchNamedPaths } from "../../lib/engineeringAgentV22PatchApply.ts";

// The result-review Decision Maker card is on by default (owner decision 2026-11-15); these settlement
// cases are about the usage ledger and the Task's destination, and their world has no review table.
process.env.TOMVERSE_AMUX_V22_RESULT_REVIEW_DM = "disabled";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-13T12:00:00.000Z");
const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
const attemptId = "00000000-0000-4000-8000-000000000003";
const worker = "worker-one";
const instanceId = "instance-one";
const catalogDigest = "c".repeat(64);
const ideaId = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

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
    ownerRetriedRejectionAttemptNumber: null as number | null,
    reviewRejectionCountWhere: null as Record<string, unknown> | null,
    reviewAuditCount: 0,
    reviewRepeats: false,
    reviewCreated: null as Record<string, unknown> | null,
    reviewAuditMetadata: null as Record<string, unknown> | null,
    findingsCreated: null as Record<string, unknown> | null,
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
    ownerQuestion: null as { id: string; state: string } | null,
    questionAnswerClears: 0,
    questionCancels: 0,
    escalations: [] as Array<Record<string, unknown>>,
    infraAttemptsBefore: 0,
    infraWindowBefore: null as number | null,
    recentRuns: [] as Array<{ outcome: string | null; reason: string | null }>,
  };
}

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>) {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await run(); } finally {
    if (prior === undefined) delete process.env[name]; else process.env[name] = prior;
  }
}
/** lib/amux/infraFailureCore.ts; on unless `disabled`. */
function withInfraRouting<T>(value: string | undefined, run: () => Promise<T>) {
  return withEnv("TOMVERSE_AMUX_INFRA_FAILURE_ROUTING", value, run);
}
/** lib/amux/v22ReadBackProceedCore.ts; on unless `disabled`. */
function withReadBackProceed<T>(value: string | undefined, run: () => Promise<T>) {
  return withEnv("TOMVERSE_AMUX_V22_READ_BACK_PROCEED", value, run);
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
  takeAuditChainLock: async () => {},
  writeSystemAuditLog: async (input: { action: string; metadata?: Record<string, unknown> }) => {
    if (input.action === "amux.cli_usage.recorded") world.usageAudits += 1;
    if (input.action === "amux.v22.execution.settled")
      world.settlementAudits += 1;
    if (input.action === "amux.grade.escalated")
      world.gradeEscalationAudits.push(input as unknown as Record<string, unknown>);
    if (input.action === "amux.review.recorded") {
      world.reviewAuditCount += 1;
      world.reviewAuditMetadata = input.metadata ?? null;
    }
    return `audit-${input.action}`;
  },
} });
mock.module(mod("lib/amux/delivery.ts"), { namedExports: {
  cancelPendingAmuxWorkDelivery: async () => undefined,
} });
mock.module(mod("lib/amux/escalation.ts"), { namedExports: {
  openAmuxHumanEscalation: async (_tx: unknown, input: Record<string, unknown>) => {
    world.escalations.push(input);
  },
} });
mock.module(mod("lib/engineeringAgentV22SettlementPatch.ts"), {
  // As the real loader adds them: every path the text names, and stored files.
  namedExports: { loadEngineeringAgentV22SettlementPatch: async () => world.patch &&
    { ...world.patch, paths: v22PatchNamedPaths(world.patch.text,
      world.patch.files ?? null) } },
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
    // The Task's earlier infrastructure failures, all and since a person's
    // last retry (lib/amux/infraFailureStore.ts, 2026-11-15).
    if (sql.includes('COUNT(*)::int AS "total"')) return [{
      total: world.infraAttemptsBefore,
      infraWindow: world.infraWindowBefore ?? world.infraAttemptsBefore }];
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
      findings: world.reviewRepeats ? { repeatsPrior: true } : null,
      auditLog: { entryHash: "a".repeat(64) },
    } : null),
    count: async ({ where }: { where: Record<string, unknown> }) => {
      world.reviewRejectionCountWhere = where;
      return world.priorReviewRejections;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      world.reviewCreated = data;
      return data;
    },
  },
  amuxReviewProposal: { findFirst: async () =>
    world.ownerRetriedRejectionAttemptNumber === null ? null :
      { attempt: { attemptNumber: world.ownerRetriedRejectionAttemptNumber } } },
  amuxIdeaUnitDecision: { findUnique: async () => ({
    confirmationSnapshot: { card: { task: { costReceipt: {
      role: "implement", grade: "routine", receiptDigest: "a".repeat(64),
    } } } },
  }) },
  engineeringAgentWorkItem: { findFirst: async () => null },
  amuxV22TaskQuestion: {
    findUnique: async () => world.ownerQuestion,
    updateMany: async () => { world.questionAnswerClears += 1; return { count: 0 }; },
    update: async () => { world.questionCancels += 1; },
  },
  amuxWorkItem: {
    update: async (input: { data: Record<string, unknown> }) => {
      world.taskUpdates += 1;
      world.gradeAuditsAtTaskUpdate = world.gradeEscalationAudits.length;
      world.taskUpdateData = input.data;
    },
    findUnique: async () => ({ sourceSnapshot: { schemaVersion: "amux-v4", ideaId } }),
  },
  amuxV52ReviewFindings: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      world.findingsCreated = data;
      return data;
    },
  },
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
    // The Task's earlier ended runs (lib/amux/infraFailureStore.ts, 2026-11-15).
    findMany: async () => world.recentRuns,
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
      // The paid retry's own bound of two; stored under the escalation's
      // code since 2026-11-15 (it was the budget core's `attempts`).
      assert.equal(world.attemptUpdateData?.reason,
        outcome === "failed" ? "attempt_budget_exhausted" : "reported_result");
    });
}

test("other Tasks keep the global settlement budget: thirty, or five with the switch disabled", async () => {
  // Owner direction 2026-11-15: no fixed five; the runaway guard of thirty
  // (executionBudgetCore.ts) is the global bound unless the switch is off.
  const cases = [[4, "todo", null, undefined], [4, "todo", "approval-other", undefined],
    [5, "todo", null, undefined], [29, "todo", null, undefined],
    [30, "blocked", null, undefined], [5, "blocked", null, "disabled"]] as const;
  for (const [attemptNumber, expectedStatus, approvalId, routing] of cases)
    await withInfraRouting(routing, async () => {
    world = makeWorld("failed");
    world.taskId = "00000000-0000-4000-8000-000000000099";
    world.attemptId = `00000000-0000-4000-8000-${String(attemptNumber).padStart(12, "0")}`;
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
      expectedStatus === "blocked" ? "attempt_budget_exhausted" : "reported_result");
  });
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
  // The frontier rerun starts over and still needs the owner's answer.
  assert.equal(world.questionAnswerClears, 0);
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

// Owner decision 2026-11-15: no fixed count blocks a Task. A rejection runs it
// again with the findings; only the same reviewer rejecting for the same
// blocking finding again goes to a person or the Decision Maker.
test("v52 review reject runs the Task again; the same finding rejected again blocks it", async () => {
  for (const [prior, repeats, retryEnv, expected, reason] of [
    [0, false, undefined, "todo", "review_server_rejected"],
    [1, false, undefined, "todo", "review_server_rejected"],
    [4, false, undefined, "todo", "review_server_rejected"],
    [1, true, undefined, "blocked", "review_server_rejected_twice"],
    [0, true, undefined, "todo", "review_server_rejected"],
    [1, false, "disabled", "blocked", "review_server_rejected_twice"],
  ] as const) {
    const previousEnv = process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET;
    if (retryEnv === undefined) delete process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET;
    else process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET = retryEnv;
    try {
      world = makeWorld("succeeded");
      world.attemptNumber = 1;
      world.gradeGuard = true;
      world.assignmentRole = "implement";
      world.taskGrade = "advanced";
      world.reviewVerdict = "reject";
      world.reviewRepeats = repeats;
      world.priorReviewRejections = prior;
      world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
        sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
        files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
      const input = await settlementInput("succeeded");
      const result = await (await execution).settleAmuxV22TaskExecution({
        ...input, changedPaths: ["lib/ordinary.ts"],
      });
      assert.equal(result.settled, true);
      assert.equal(world.taskUpdateData?.status, expected, JSON.stringify([prior, repeats, retryEnv]));
      assert.equal(world.attemptUpdateData?.reason, reason);
      assert.equal(world.taskUpdateData?.executionGrade, undefined,
        "review rejection cannot escalate grade");
    } finally {
      if (previousEnv === undefined) delete process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET;
      else process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET = previousEnv;
    }
  }
});

test("an owner retry of a twice-rejected run counts only later rejections", async () => {
  for (const [retried, expectedWhere] of [
    [null, { taskId, verdict: "reject", attemptId: { not: attemptId } }],
    [2, { taskId, verdict: "reject", attemptId: { not: attemptId },
      attempt: { attemptNumber: { gt: 2 } } }],
  ] as const) {
    world = makeWorld("succeeded");
    world.attemptNumber = 1;
    world.gradeGuard = true;
    world.assignmentRole = "implement";
    world.taskGrade = "advanced";
    world.reviewVerdict = "reject";
    world.ownerRetriedRejectionAttemptNumber = retried;
    world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
      sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
      files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
    const input = await settlementInput("succeeded");
    const result = await (await execution).settleAmuxV22TaskExecution({
      ...input, changedPaths: ["lib/ordinary.ts"],
    });
    assert.equal(result.settled, true);
    assert.deepEqual(world.reviewRejectionCountWhere, expectedWhere);
    // The mocked count after the retry is 0: its first rejection goes back.
    assert.equal(world.taskUpdateData?.status, "todo");
    assert.equal(world.attemptUpdateData?.reason, "review_server_rejected");
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

// Owner decision 2026-11-15: a reject's findings are sealed as one AMUX content
// unit beside the record, in the record's transaction. They are display and
// prompt data: never in the request digest, never a reason to change the verdict.
test("a v52 reject seals its findings under the attempt's key; another verdict stores none", async () => {
  const previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "v52-review-test-key".repeat(4);
  try {
    const core = await import(mod("lib/amux/v52ReviewFindingsCore.ts"));
    const crypto = await import(mod("lib/amux/ideaCrypto.ts"));
    const token = `ghp_${"A".repeat(36)}`;
    const doc = core.parseAmuxV52FindingsTransport(JSON.stringify({ version: 1, reviewers: [{
      vendor: "openai", verdict: "reject", findings: [
        { severity: "major", file: "lib/ordinary.ts", line: 3, summary: `leaks ${token}` },
        { severity: "minor", summary: "see https://review.internal.example/x for the trace" }] }] }));
    const makeKeys = () => ({ masterKeyId: `amux2-${"k".repeat(20)}`, masterKeyVersion: 1,
      masterKey: randomBytes(32), digestKeyId: "digest-one", digestKey: randomBytes(32) });
    const evidence = { jobId: "r-20261016-110000-abcdef", baseSha: "a".repeat(40),
      commitSha: "c".repeat(40), authorVendor: "anthropic", reviewerVendors: ["openai"],
      touchesContract: false };
    const runs: Array<{ created: Record<string, unknown> | null;
      findings: Record<string, unknown> | null; audit: Record<string, unknown> | null;
      keys: ReturnType<typeof makeKeys>; keyCopy: ReturnType<typeof makeKeys> }> = [];
    const digests: unknown[] = [];
    for (const [verdict, prepared, foreignIdea] of [
      ["reject", true, false], ["reject", false, false], ["accept", true, false],
      ["reject", true, true],
    ] as const) {
      world = makeWorld("succeeded");
      world.gradeGuard = true;
      world.assignmentRole = "implement";
      world.taskGrade = "advanced";
      world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
        sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
        files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
      const keys = makeKeys();
      // The call clears its key when it ends, so a copy is kept to read the body back.
      const keyCopy = { ...keys, masterKey: Buffer.from(keys.masterKey) };
      const result = await (await execution).recordAmuxV52Review({ attemptId, worker,
        instanceId, generation: 1, taskRevision: 5, changedPaths: ["lib/ordinary.ts"],
        evidence: { ...evidence, verdict },
        findings: prepared ? { doc, keys, ideaId: foreignIdea ?
          "11111111-2222-4333-8444-555555555555" : ideaId } : null });
      assert.deepEqual(result, { recorded: true, duplicate: false });
      runs.push({ created: world.reviewCreated, findings: world.findingsCreated,
        audit: world.reviewAuditMetadata, keys, keyCopy });
      digests.push(world.reviewCreated?.requestDigest);
    }
    const [sealed, bare, accepted, foreign] = runs;
    assert.ok(sealed.findings, "a reject with findings stores the sealed body");
    assert.equal(sealed.findings.attemptId, attemptId);
    assert.equal(sealed.findings.taskId, taskId);
    assert.equal(sealed.findings.ideaId, ideaId);
    assert.equal(sealed.findings.findingCount, 2);
    const ciphertext = Buffer.from(sealed.findings.ciphertext as Uint8Array);
    assert.equal(ciphertext.includes("lib/ordinary.ts"), false, "the body is not stored in the clear");
    const plain = crypto.openAmuxContent({ ciphertext, keyId: sealed.findings.keyId as string,
      keyVersion: sealed.findings.keyVersion as number }, "review_findings", attemptId,
    sealed.keyCopy);
    assert.equal(crypto.verifyAmuxContentDigest(plain, "review_findings", attemptId,
      sealed.findings.digest as string, sealed.findings.digestKeyId as string, sealed.keyCopy), true);
    assert.deepEqual(core.decodeAmuxV52FindingsDoc(plain), doc);
    assert.equal(plain.toString("utf8").includes("ghp_"), false, "a credential-like line never reaches the body");
    assert.equal(plain.toString("utf8").includes("review.internal.example"), false);
    // The key is cleared when the call ends.
    assert.equal(sealed.keys.masterKey.every((byte) => byte === 0), true);
    // The record no longer keeps the reasons in the clear; the audit names the body by digest and count.
    assert.equal("findingsSummary" in (sealed.created ?? {}), false);
    assert.equal(sealed.audit?.findingsDigest, sealed.findings.digest);
    assert.equal(sealed.audit?.findingCount, 2);
    assert.equal(JSON.stringify(sealed.audit).includes("lib/ordinary.ts"), false);
    // A reject without findings, another verdict, or a key made for another idea stores no body.
    assert.equal(bare.findings, null);
    assert.equal(bare.audit?.findingsDigest, undefined);
    assert.equal(accepted.findings, null);
    assert.equal(foreign.findings, null);
    assert.equal(foreign.created?.verdict, "reject", "the verdict is still recorded");
    // The findings never enter the digest the bridge's readback compares.
    assert.equal(digests[0], digests[1]);
    assert.equal(digests[0], digests[3]);
  } finally {
    if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
  }
});

test("an accepted patch whose start opened no publication run settles privately for review", async () => {
  // Production 2026-11-06: the Publisher was halted, start skipped the run
  // (v22_publication_skipped), and settlement refused the accepted patch with
  // 409, which stopped the worker bridge and left the Task outcome_unknown.
  world = makeWorld("succeeded");
  world.attemptNumber = 1;
  world.gradeGuard = true;
  world.assignmentRole = "implement";
  world.taskGrade = "advanced";
  world.reviewVerdict = "accept";
  world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
    sha256: "b".repeat(64), text: "diff --git a/lib/ordinary.ts b/lib/ordinary.ts\n",
    files: [{ path: "lib/ordinary.ts", mode: "100644", bytesBase64: "YQ==" }] };
  const input = await settlementInput("succeeded");
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...input, changedPaths: ["lib/ordinary.ts"],
  });
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "review");
  assert.equal(world.attemptUpdateData?.reason, "review_server_accepted");
  assert.equal(world.escalations.length, 1);
  assert.equal(world.escalations[0]?.reason, "human_review_required");
});

test("v52 review unknown asks for the review again by running the Task again; the old rule blocks", async () => {
  for (const [retryEnv, expected] of [[undefined, "todo"], ["disabled", "blocked"]] as const) {
  const previousEnv = process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET;
  if (retryEnv === undefined) delete process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET;
  else process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET = retryEnv;
  try {
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
  assert.equal(world.taskUpdateData?.status, expected);
  assert.equal(world.attemptUpdateData?.reason, "review_server_unknown");
  } finally {
    if (previousEnv === undefined) delete process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET;
    else process.env.TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET = previousEnv;
  }
  }
});

test("v52 contract touch on the final attempt blocks for human recovery", async () => {
  world = makeWorld("failed");
  world.taskId = "00000000-0000-4000-8000-000000000099";
  // The final attempt is the runaway guard since 2026-11-15.
  world.attemptNumber = 30;
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
  // A run with no result is a platform failure since 2026-11-15 and goes back
  // to todo; with the switch disabled it is blocked as before. Either way the
  // missing inventory is not its cause.
  for (const [routing, status] of [[undefined, "todo"], ["disabled", "blocked"]] as const) {
    await withInfraRouting(routing, async () => {
      world = makeWorld("failed");
      world.gradeGuard = true;
      world.taskGrade = "routine";
      const result = await (await execution).settleAmuxV22TaskExecution({
        attemptId: world.attemptId, worker, instanceId, generation: 1,
        taskRevision: 5, outcome: "blocked", invocationIds: [],
      });
      assert.equal(result.settled, true);
      assert.equal(world.taskUpdateData?.status, status);
      assert.notEqual(world.attemptUpdateData?.reason, "changed_paths_unavailable");
    });
  }
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

const claudeFailedEvent = (cliFailure: string | null) => ({
  invocationId: attemptId, receiptDigest: "8".repeat(64), status: "failed",
  completeness: "reported_partial", projectedApiCostMicrousd: BigInt(1),
  cli: "claude", source: "claude_result", actualModelId: "claude-opus-5-5",
  selectedModelId: "claude-opus-5-5", provider: "anthropic",
  authentication: "subscription", inputTokens: BigInt(1),
  outputTokens: BigInt(1), cacheReadInputTokens: BigInt(0),
  cacheCreationInputTokens: BigInt(0), inputTokensIncludeCacheRead: false,
  inputTokensIncludeCacheWrite: false, completedTurns: 13, cliFailure,
  pricingVersion: null });

/** The box bridge settles a failed CLI run as "failed" with its receipt and,
 * refused for an incomplete receipt, again as "blocked" with none. */
async function settleLikeBridge() {
  const verified = await (await execution).settleAmuxV22TaskExecution({
    attemptId, worker, instanceId, generation: 1, taskRevision: 5,
    outcome: "failed", invocationIds: [attemptId] });
  assert.deepEqual(verified, { settled: false, reason: "usage_unverified" });
  return (await execution).settleAmuxV22TaskExecution({
    attemptId, worker, instanceId, generation: 1, taskRevision: 5,
    outcome: "blocked", invocationIds: [] });
}

async function ownerMayRetry() {
  const { amuxV22ReviewRetryHasVerifiedOutcome } =
    await import(mod("lib/amux/reviewApprovalCore.ts"));
  return amuxV22ReviewRetryHasVerifiedOutcome({ sourceSystem: "admin-idea-v4",
    attempt: { v22AssignmentId: "assignment-one", outcome: "blocked",
      toStatus: "blocked", reason: String(world.attemptUpdateData?.reason) } });
}

test("a Claude turn-limit failure is a known failure the owner may retry", async () => {
  for (const [cliFailure, reason] of [["turn_limit", "cli_turn_limit"],
    ["execution_error", "cli_execution_error"],
    ["budget_limit", "cli_budget_limit"]]) {
    world = makeWorld("failed");
    world.storedEvents = [claudeFailedEvent(cliFailure)];
    const result = await settleLikeBridge();
    assert.equal(result.settled, true);
    // The partial receipt certifies no cost: the Task waits for the owner
    // instead of requeueing itself, but for a known cause.
    assert.equal(world.taskUpdateData?.status, "blocked");
    assert.equal(world.attemptUpdateData?.outcome, "blocked");
    assert.equal(world.attemptUpdateData?.reason, reason);
    assert.equal(world.escalations.at(-1)?.reason, reason);
    assert.equal(await ownerMayRetry(), true);
  }
});

const unnamedFailures = () => [[claudeFailedEvent("unknown")],
  [claudeFailedEvent(null)], []];

test("an unnamed CLI failure is the run's own; a run with no receipt is the platform's", () =>
  withInfraRouting(undefined, async () => {
    for (const events of unnamedFailures()) {
      world = makeWorld("failed");
      // An ordinary subscription card, not the paid read-only retry with its
      // own bound of two.
      world.taskId = "00000000-0000-4000-8000-000000000099";
      world.recoveryApprovalId = null;
      world.storedEvents = events;
      // With TOMVERSE_AMUX_V22_READ_BACK_PROCEED on (the default since
      // 2026-11-15) a subscription CLI's partial receipt is recorded, not a
      // gate: the failed run settles at once and counts as an attempt.
      // A deadline, signal or lost sidecar leaves no receipt; the bridge
      // settles it blocked, and that run did none of the card's work
      // (lib/amux/infraFailureCore.ts): back to todo, no attempt used.
      const result = await (await execution).settleAmuxV22TaskExecution({
        attemptId, worker, instanceId, generation: 1, taskRevision: 5,
        outcome: events.length ? "failed" : "blocked",
        invocationIds: events.length ? [attemptId] : [] });
      assert.equal(result.settled, true);
      assert.equal(world.taskUpdateData?.status, "todo");
      assert.equal(world.attemptUpdateData?.reason,
        events.length ? "cli_usage_unreported" : "infra_no_result");
      assert.equal(world.escalations.length, 0);
    }
  }));

test("with both switches disabled the same failure stays unknown", () =>
  withInfraRouting("disabled", () => withReadBackProceed("disabled", async () => {
    for (const events of unnamedFailures()) {
      world = makeWorld("failed");
      world.storedEvents = events;
      const result = events.length ? await settleLikeBridge() :
        await (await execution).settleAmuxV22TaskExecution({
          attemptId, worker, instanceId, generation: 1, taskRevision: 5,
          outcome: "blocked", invocationIds: [] });
      assert.equal(result.settled, true);
      assert.equal(world.taskUpdateData?.status, "blocked");
      assert.equal(world.attemptUpdateData?.reason, "usage_outcome_unknown");
      assert.equal(await ownerMayRetry(), false);
    }
  })));

test("the twelfth platform failure blocks the card but is still counted as one", () =>
  withInfraRouting(undefined, async () => {
    // Review r-20261115-120153-60193b: the bound is named by the escalation;
    // the attempt keeps its own reason so the budget and the worker's
    // quarantine still count it.
    world = makeWorld("failed");
    world.taskId = "00000000-0000-4000-8000-000000000099";
    world.recoveryApprovalId = null;
    world.infraAttemptsBefore = 11;
    world.attemptNumber = 12;
    const result = await (await execution).settleAmuxV22TaskExecution({
      attemptId, worker, instanceId, generation: 1, taskRevision: 5,
      outcome: "blocked", invocationIds: [] });
    assert.equal(result.settled, true);
    assert.equal(world.taskUpdateData?.status, "blocked");
    assert.equal(world.attemptUpdateData?.reason, "infra_no_result");
    assert.equal(world.escalations.at(-1)?.reason, "infra_attempts_exhausted");
  }));

test("after a person's retry the platform failures before it do not count toward the bound", () =>
  withInfraRouting(undefined, async () => {
    // Eleven failures before the person sent the card back, two since: the
    // card goes on (the bound counts those since the retry).
    world = makeWorld("failed");
    world.taskId = "00000000-0000-4000-8000-000000000099";
    world.recoveryApprovalId = null;
    world.infraAttemptsBefore = 13;
    world.infraWindowBefore = 2;
    world.attemptNumber = 15;
    const result = await (await execution).settleAmuxV22TaskExecution({
      attemptId, worker, instanceId, generation: 1, taskRevision: 5,
      outcome: "blocked", invocationIds: [] });
    assert.equal(result.settled, true);
    assert.equal(world.taskUpdateData?.status, "todo");
    assert.equal(world.attemptUpdateData?.reason, "infra_no_result");
    assert.equal(world.escalations.length, 0);
  }));

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
  // A settlement at the same grade spends a resumed run's answer.
  assert.equal(world.questionAnswerClears, 1);
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

test("a run that ended with an owner question waits blocked, unreviewed and unpublished", async () => {
  world = makeWorld("succeeded");
  world.gradeGuard = true;
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.assignmentRole = "implement";
  world.sourceApprovalId = "source-one";
  world.patch = { taskId, baseSha: "a".repeat(40), sha256: "b".repeat(64),
    text: "diff --git a/lib/amux/execution.ts b/lib/amux/execution.ts\n",
    files: null };
  world.ownerQuestion = { id: "question-one", state: "open" };
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("succeeded"),
    changedPaths: ["lib/amux/execution.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.attemptUpdateData?.toStatus, "blocked");
  assert.equal(world.attemptUpdateData?.reason, "owner_question");
  // Its partial change is neither graded, reviewed nor escalated.
  assert.equal(world.gradeEscalationAudits.length, 0);
  assert.equal(world.taskUpdateData?.executionGrade, undefined);
  assert.equal(world.reviewCreated, null);
  assert.deepEqual(world.escalations, []);
  // Settlement clears the answer of a question this attempt resumed.
  assert.equal(world.questionAnswerClears, 1);
});

test("a fourth question opens like the first: there is no question limit", async () => {
  // Owner decision 2026-11-15: the three-question limit is gone. The question row a run's fourth
  // question is recorded as is open, and settlement parks the Task for its answer, no escalation.
  const { amuxV22OwnerQuestionSettlement } = await import(mod("lib/amux/v22OwnerQuestionCore.ts"));
  assert.deepEqual(amuxV22OwnerQuestionSettlement(), { questionState: "open", reason: "owner_question" });
  world = makeWorld("succeeded");
  world.ownerQuestion = { id: "question-four", state: "open" };
  const result = await (await execution).settleAmuxV22TaskExecution(
    await settlementInput("succeeded"));
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.attemptUpdateData?.reason, "owner_question");
  assert.notEqual(world.attemptUpdateData?.reason, "owner_question_limit");
  assert.deepEqual(world.escalations, []);
});

test("a question row that was cancelled still blocks the Task for a person", async () => {
  // Rows recorded under the old limit read back as before: settlement escalates a cancelled question.
  world = makeWorld("succeeded");
  world.ownerQuestion = { id: "question-cancelled", state: "cancelled" };
  const result = await (await execution).settleAmuxV22TaskExecution(
    await settlementInput("succeeded"));
  assert.equal(result.settled, true);
  assert.equal(world.taskUpdateData?.status, "blocked");
  assert.equal(world.attemptUpdateData?.reason, "owner_question_limit");
  assert.equal(world.escalations.length, 1);
  assert.equal(world.escalations[0]?.reason, "owner_question_limit");
});

test("a question whose run fails is cancelled, never left holding the Task", async () => {
  world = makeWorld("failed");
  world.ownerQuestion = { id: "question-failed", state: "open" };
  const result = await (await execution).settleAmuxV22TaskExecution(
    await settlementInput("failed"));
  assert.equal(result.settled, true);
  assert.notEqual(world.attemptUpdateData?.reason, "owner_question");
  assert.equal(world.questionCancels, 1);
});

// Owner decision 2026-11-15 (local CLI flow, lib/amux/v22LocalCliFlowCore.ts):
// a lower grade's contract change is kept and judged at frontier in place.
function inPlaceWorld(reviewVerdict: "accept" | "reject" | null) {
  world = makeWorld("succeeded");
  world.attemptNumber = 1;
  world.gradeGuard = true;
  world.assignmentRole = "implement";
  world.taskRole = "implement";
  world.taskGrade = "routine";
  world.sourceApprovalId = "source-one";
  world.reviewVerdict = reviewVerdict;
  world.patch = { taskId: world.taskId, baseSha: "a".repeat(40),
    sha256: "b".repeat(64),
    text: "diff --git a/lib/amux/execution.ts b/lib/amux/execution.ts\n",
    files: [{ path: "lib/amux/execution.ts", mode: "100644", bytesBase64: "YQ==" }] };
}

test("local CLI flow: a reviewed lower-grade contract change rises to frontier in place", async () => {
  inPlaceWorld("accept");
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("succeeded"), changedPaths: ["lib/amux/execution.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  // No re-run: the kept change goes on to the frontier review path.
  assert.equal(world.taskUpdateData?.status, "review");
  assert.equal(world.taskUpdateData?.executionGrade, "frontier");
  assert.equal(world.attemptUpdateData?.reason, "review_server_accepted");
  assert.equal(world.gradeEscalationAudits.length, 1);
  assert.equal(world.gradeAuditsAtTaskUpdate, 1);
  const metadata = world.gradeEscalationAudits[0]?.metadata as Record<string, unknown>;
  assert.equal(metadata.reason, "contract_path_touched");
  assert.equal(metadata.inPlace, true);
  assert.equal(metadata.toStatus, "review");
  assert.equal(world.escalations[0]?.reason, "human_review_required");
});

test("local CLI flow: a rejected in-place change retries at frontier with its grade raised", async () => {
  inPlaceWorld("reject");
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("succeeded"), changedPaths: ["lib/amux/execution.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  assert.equal(world.taskUpdateData?.status, "todo");
  assert.equal(world.taskUpdateData?.executionGrade, "frontier");
  assert.equal(world.attemptUpdateData?.reason, "review_server_rejected");
});

test("local CLI flow: without a recorded review the contract change escalates as before", async () => {
  inPlaceWorld(null);
  const result = await (await execution).settleAmuxV22TaskExecution({
    ...await settlementInput("succeeded"), changedPaths: ["lib/amux/execution.ts"],
  });
  assert.deepEqual(result, { settled: true, taskRevision: 6 });
  assert.equal(world.taskUpdateData?.status, "todo");
  assert.equal(world.taskUpdateData?.executionGrade, "frontier");
  assert.equal(world.attemptUpdateData?.reason, "contract_path_touched");
  assert.equal((world.gradeEscalationAudits[0]?.metadata as Record<string, unknown>)
    .inPlace, undefined);
});

test("the earlier flow never judges a lower grade's contract change in place", async () => {
  const previous = process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW;
  process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW = "disabled";
  try {
    inPlaceWorld("accept");
    const result = await (await execution).settleAmuxV22TaskExecution({
      ...await settlementInput("succeeded"), changedPaths: ["lib/amux/execution.ts"],
    });
    assert.deepEqual(result, { settled: true, taskRevision: 6 });
    assert.equal(world.taskUpdateData?.status, "todo");
    assert.equal(world.attemptUpdateData?.reason, "contract_path_touched");
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW;
    else process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW = previous;
  }
});

test("local CLI flow: a lower grade's kept contract change may record its review", async () => {
  const previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  const previousFlow = process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "v52-review-test-key".repeat(4);
  try {
    const input = { attemptId, worker, instanceId, generation: 1, taskRevision: 5,
      changedPaths: ["lib/amux/execution.ts"], evidence: {
        jobId: "r-20261115-110000-abcdef", baseSha: "a".repeat(40),
        commitSha: "c".repeat(40), verdict: "accept" as const,
        authorVendor: "anthropic", reviewerVendors: ["openai", "xai"],
        touchesContract: true } };
    for (const [flow, expected] of [["disabled",
      { recorded: false, reason: "review_patch_unverified" }],
    [undefined, { recorded: true, duplicate: false }]] as const) {
      if (flow === undefined) delete process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW;
      else process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW = flow;
      inPlaceWorld(null);
      world.taskGrade = "advanced";
      world.patch!.files = null;
      assert.deepEqual(await (await execution).recordAmuxV52Review(input), expected);
    }
    // An invalid path is never recorded, whatever the flow.
    inPlaceWorld(null);
    world.taskGrade = "advanced";
    world.patch!.files = null;
    assert.deepEqual(await (await execution).recordAmuxV52Review({
      ...input, changedPaths: ["lib/amux/execution.ts", "../escape.ts"] }),
    { recorded: false, reason: "review_patch_unverified" });
  } finally {
    if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
    if (previousFlow === undefined) delete process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW;
    else process.env.TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW = previousFlow;
  }
});
