import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const catalogDigest = "c".repeat(64);
const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
let auditInput: Record<string, unknown> | null = null;
let auditCalls = 0;

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async (input: Record<string, unknown>) => {
    auditCalls += 1;
    auditInput = input;
    return "audit-usage-one";
  },
} });
mock.module(mod("lib/amux/v4TaskCostCatalogCore.ts"), { namedExports: {
  inspectV4TaskCostCatalog: () => ({ ok: true, catalogDigest }),
} });

const protocol = import(mod("lib/amux/v22ReadOnlyApiProtocol.mjs"));
const store = import(mod("lib/amux/cliUsageLedgerStore.ts"));

test("API receipt records one current-priced complete usage event and replay adds nothing",
  async () => {
    const p = await protocol;
    const frame = p.parseAmuxV22ReadOnlyApiExecutionFrame({
      version: 1,
      executorKind: "read_only_api_retry_v1",
      provider: "anthropic",
      modelId: "claude-opus-5-5",
      routeId: "read-only-route",
      routePolicyDigest: "d".repeat(64),
      catalogApprovalId: "catalog-one",
      catalogVersion: "v1",
      catalogDigest,
      pricingVersion: "price-v1",
      pricingSource: "approved-catalog",
      pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
      pricingExpiresAt: "2026-10-14T00:00:00.000Z",
      uncachedInputMicroUsdPerMillion: 1_000_000,
      cacheReadMicroUsdPerMillion: 100_000,
      cacheWriteMicroUsdPerMillion: 200_000,
      outputMicroUsdPerMillion: 2_000_000,
      tokenLimits: { uncachedInputTokens: 10, cacheReadTokens: 10,
        cacheWriteTokens: 10, outputTokens: 10 },
      maxProviderTurns: 8,
      maxOutputTokensPerTurn: 10,
      maxRetries: 0,
      maximumCostMicroUsd: 33,
      credentialProfileId: "recovery-api-key",
      credentialMetadataDigest: "e".repeat(64),
      executorArtifactDigest: "f".repeat(64),
      settingsDigest: p.AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
      repositoryScopeDigest: "1".repeat(64),
      brokerPolicyDigest: p.AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
      toolSchemaDigest: p.AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
    }, { now: new Date("2026-10-13T12:00:00.000Z") });
    const attemptId = "00000000-0000-4000-8000-000000000003";
    const receiptBody = {
      version: 1,
      executorKind: "read_only_api_retry_v1",
      attemptId,
      invocationId: attemptId,
      selectedModelId: frame.modelId,
      actualModelId: frame.modelId,
      actualModelUniform: true,
      providerTurnCount: 2,
      uncachedInputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      outputTokens: 6,
      usageComplete: true,
      terminalStatus: "succeeded",
      apiExecutionFrameDigest: p.amuxV22ReadOnlyApiExecutionFrameDigest(frame),
      projectedCostMicroUsd: p.projectAmuxV22ReadOnlyApiCost(frame, {
        uncachedInputTokens: 3, cacheReadTokens: 4,
        cacheWriteTokens: 5, outputTokens: 6,
      }),
    } as const;
    const receipt = { ...receiptBody,
      digest: p.amuxV22ReadOnlyApiExecutionReceiptDigest(receiptBody) };
    const existingDigests = new Map<string, string>();
    let boundTaskId = taskId;
    let inserts = 0;
    const insertedValues: unknown[][] = [];
    const tx = {
      amuxV4TaskCostCatalogApproval: { findFirst: async () => ({
        id: "catalog-one", status: "approved", revokedAt: null,
        catalogDigest, approvalAuditLogId: "catalog-audit",
        approvedByUserId: "owner-one", pricingVersion: "price-v1",
        catalog: { routes: [{ enabled: true, workerName: "worker-one",
          provider: "anthropic", modelId: frame.modelId,
          pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
          pricingExpiresAt: "2026-10-14T00:00:00.000Z",
          uncachedInputMicroUsdPerMillion: 1_000_000,
          cacheReadMicroUsdPerMillion: 100_000,
          cacheWriteMicroUsdPerMillion: 200_000,
          outputMicroUsdPerMillion: 2_000_000 }] },
      }) },
      adminAuditLog: { findUnique: async () => ({ entryHash: "a".repeat(64),
        action: "amux.v4.task_catalog.approve", actorUserId: "owner-one",
        targetId: "catalog-one", targetType: "AmuxV4TaskCostCatalogApproval" }) },
      amuxCliUsageEvent: { findUnique: async (query: {
        where: { invocationId: string } }) => {
        const receiptDigest = existingDigests.get(query.where.invocationId);
        return receiptDigest ? { receiptDigest } : null;
      } },
      amuxExecutionAttempt: { findUnique: async () => ({
        taskId: boundTaskId, worker: "worker-one",
        startedAt: new Date("2026-10-13T11:59:00.000Z"), endedAt: null,
        v22AssignmentId: "assignment-one",
        task: { sourceSystem: "admin-idea-v4",
          v22AssignmentId: "assignment-one",
          v22AcceptedAssignment: { workerName: "worker-one",
            provider: "anthropic", modelId: frame.modelId } },
      }) },
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        inserts += 1;
        insertedValues.push(values);
        return [{ id: "usage-one" }];
      },
    };
    const input = { worker: "worker-one", attemptId,
      attemptStartedAt: new Date("2026-10-13T11:59:00.000Z"),
      endedAt: new Date("2026-10-13T12:00:00.000Z"),
      launchScopeDigest: "2".repeat(64), frame, receipt };
    const { recordAmuxV22ReadOnlyApiUsage } = await store;
    const first = await recordAmuxV22ReadOnlyApiUsage(tx as never, input);
    assert.equal(first.duplicate, false);
    assert.equal(first.receiptDigest, receipt.digest);
    assert.equal(insertedValues[0]?.[2], receipt.digest);
    assert.equal(insertedValues[0]?.[8], "anthropic_api");
    assert.equal(insertedValues[0]?.[18], "anthropic_messages_api");
    existingDigests.set(attemptId, first.receiptDigest);
    const replay = await recordAmuxV22ReadOnlyApiUsage(tx as never, input);
    assert.equal(replay.duplicate, true);
    const conflictingBody = { ...receiptBody,
      terminalStatus: "failed" as const };
    const conflictingReceipt = { ...conflictingBody,
      digest: p.amuxV22ReadOnlyApiExecutionReceiptDigest(conflictingBody) };
    await assert.rejects(recordAmuxV22ReadOnlyApiUsage(tx as never, {
      ...input, receipt: conflictingReceipt,
    }), /receipt_conflict/);
    assert.equal(inserts, 1);
    assert.equal(auditCalls, 1);
    const metadata = auditInput?.metadata as Record<string, unknown>;
    assert.equal(metadata.authenticationMode, "api_key");
    assert.equal(metadata.launchScopeDigest, input.launchScopeDigest);
    assert.equal(metadata.apiExecutionFrameDigest, receipt.apiExecutionFrameDigest);
    assert.equal(metadata.apiExecutionReceiptDigest, receipt.digest);
    assert.deepEqual(metadata.apiExecutionReceipt, receipt);

    boundTaskId = "task-outside-approved-recovery";
    const outOfScopeId = "00000000-0000-4000-8000-000000000005";
    const outOfScopeBody = { ...receiptBody, attemptId: outOfScopeId,
      invocationId: outOfScopeId };
    const outOfScopeReceipt = { ...outOfScopeBody,
      digest: p.amuxV22ReadOnlyApiExecutionReceiptDigest(outOfScopeBody) };
    await assert.rejects(recordAmuxV22ReadOnlyApiUsage(tx as never, {
      ...input, attemptId: outOfScopeId, receipt: outOfScopeReceipt,
    }), /binding_mismatch/);
    assert.equal(inserts, 1);
    assert.equal(auditCalls, 1);
    boundTaskId = taskId;

    const failedAttemptId = "00000000-0000-4000-8000-000000000004";
    const failedBody = { ...receiptBody, attemptId: failedAttemptId,
      invocationId: failedAttemptId, terminalStatus: "failed" as const };
    const failedReceipt = { ...failedBody,
      digest: p.amuxV22ReadOnlyApiExecutionReceiptDigest(failedBody) };
    const failed = await recordAmuxV22ReadOnlyApiUsage(tx as never, {
      ...input, attemptId: failedAttemptId, receipt: failedReceipt,
    });
    assert.equal(failed.duplicate, false);
    assert.equal(failed.receiptDigest, failedReceipt.digest);
    assert.equal(insertedValues[1]?.[2], failedReceipt.digest);
    assert.equal(inserts, 2);
    assert.equal(auditCalls, 2);
    assert.deepEqual((auditInput?.metadata as Record<string, unknown>)
      .apiExecutionReceipt, failedReceipt);
  });
