import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { appendSyntheticAdminAudit } from
  "./helpers/appendSyntheticAdminAudit.mjs";
import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";
import { exerciseAmuxV22TaskRecoveryFixture } from
  "./helpers/amuxV22TaskRecoveryFixture.mjs";

const raw = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!raw || process.env.DATABASE_URL !== raw) return false;
  const value = new URL(raw);
  return ["localhost", "127.0.0.1"].includes(value.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(value.pathname);
})();

function prismaQueryAdapter(tx) {
  return { query: async (sql, params = []) => {
    if (/^\s*SELECT\s+pg_advisory_xact_lock\b/i.test(sql)) {
      const rowCount = await tx.$executeRawUnsafe(sql, ...params);
      return { rows: [], rowCount };
    }
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(sql)) {
      const rows = await tx.$queryRawUnsafe(sql, ...params);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await tx.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount };
  } };
}

test("CLI usage writer binds the attempt, deduplicates and audits atomically", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ prisma }, { recordAmuxCliUsage },
    { readAmuxCliUsageSummaryForAdmin }] = await Promise.all([
    import("../../lib/prisma.ts"),
    import("../../lib/amux/cliUsageLedgerStore.ts"),
    import("../../lib/amux/adminCliUsageSummary.ts"),
  ]);
  const rollback = new Error("synthetic rollback");
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const taskId = `amux-usage-task-${randomUUID()}`;
      const attemptId = randomUUID();
      await tx.amuxWorkItem.create({ data: {
        id: taskId, title: "usage writer fixture", status: "doing",
        kind: "code", priority: "p3",
      } });
      await tx.amuxExecutionAttempt.create({ data: {
        id: attemptId, taskId, worker: "worker-a",
        workerInstanceId: "fixture", workerGeneration: 1,
        taskRevision: 1, startedAt: new Date(), heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      } });
      const receipt = {
        version: 1, invocationId: randomUUID(),
        binding: { kind: "task_attempt", attemptId }, worker: "worker-a",
        cli: "claude", provider: "anthropic", selectedModelId: "claude-opus-5",
        actualModelId: "claude-opus-5", cliVersion: "2.1.288",
        authentication: "subscription", startedAt: "2026-10-06T00:00:00.000Z",
        endedAt: "2026-10-06T00:00:01.000Z", status: "failed",
        completeness: "reported_partial", source: "claude_result",
        observed: { inputTokens: 100, outputTokens: 25,
          cacheReadInputTokens: 10, cacheCreationInputTokens: 3,
          reasoningOutputTokens: null },
        inputTokensIncludeCacheRead: false,
        inputTokensIncludeCacheWrite: false,
        reasoningOutputIncludedInOutput: null, completedTurns: 1,
      };
      const first = await recordAmuxCliUsage(tx, receipt);
      assert.equal(first.duplicate, false);
      assert.ok(first.auditId);
      assert.equal((await recordAmuxCliUsage(tx, receipt)).duplicate, true);
      await assert.rejects(recordAmuxCliUsage(tx, { ...receipt,
        observed: { ...receipt.observed, inputTokens: 101 } }),
      /receipt_conflict/);
      const row = await tx.amuxCliUsageEvent.findUnique({
        where: { invocationId: receipt.invocationId },
      });
      assert.equal(row?.taskId, taskId);
      assert.equal(row?.inputTokens, BigInt(100));
      assert.equal(row?.projectedApiCostMicrousd, null);
      const summary = await readAmuxCliUsageSummaryForAdmin(tx);
      const current = summary.rows.find((entry) => entry.worker === "worker-a" &&
        entry.model === "claude-opus-5");
      assert.equal(current?.recorded, 1);
      assert.equal(current?.executor, "claude");
      assert.equal(current?.source, "claude_result");
      assert.equal(current?.reportedInputTokens, "100");
      assert.equal(current?.reportedOutputTokens, "25");
      assert.equal(current?.reportedCacheReadTokens, "10");
      assert.equal(current?.reportedCacheWriteTokens, "3");
      assert.equal(current?.knownProjectedApiCostMicrousd, "0");
      assert.equal(current?.pricedCalls, 0);
      assert.equal(await tx.amuxCliUsageEvent.count({
        where: { invocationId: receipt.invocationId },
      }), 1);
      throw rollback;
    }, { timeout: 15_000 }), (error) => error === rollback);
  } finally { await prisma.$disconnect(); }
});

test("native API writer refuses a current-catalog receipt without recovery authority", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ prisma }, protocol, catalogCore, usageStore] = await Promise.all([
    import("../../lib/prisma.ts"),
    import("../../lib/amux/v22ReadOnlyApiProtocol.mjs"),
    import("../../lib/amux/v4TaskCostCatalogCore.ts"),
    import("../../lib/amux/cliUsageLedgerStore.ts"),
  ]);
  const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
  const worker = "worker-api";
  const approvalId = randomUUID();
  const attemptId = randomUUID();
  const startedAt = new Date("2026-10-13T11:59:00.000Z");
  const endedAt = new Date("2026-10-13T12:00:00.000Z");
  const rollback = new Error("synthetic native API rollback");
  const catalog = {
    schemaVersion: 1,
    catalogVersion: `api-catalog-${randomUUID()}`,
    pricingVersion: "price-v1",
    gradeRulesVersion: "grade-v1",
    gradeRules: [{
      role: "investigate", grade: "high",
      caps: { uncachedInputTokens: 10, cacheReadTokens: 10,
        cacheWriteTokens: 10, outputTokens: 10, maxAttempts: 2 },
    }],
    routes: [{
      routeId: "read-only-route", workerName: worker,
      provider: "anthropic", modelId: "claude-opus-5-5",
      routePolicyDigest: "d".repeat(64), enabled: true,
      roles: ["investigate"], grades: ["high"],
      pricingSource: "approved-catalog",
      pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
      pricingExpiresAt: "2026-10-14T00:00:00.000Z",
      uncachedInputMicroUsdPerMillion: 1_000_000,
      cacheReadMicroUsdPerMillion: 100_000,
      cacheWriteMicroUsdPerMillion: 200_000,
      outputMicroUsdPerMillion: 2_000_000,
      toolCostCapMicroUsdPerAttempt: 0,
    }],
  };
  const inspection = catalogCore.inspectV4TaskCostCatalog(catalog);
  assert.equal(inspection.ok, true);
  const catalogDigest = inspection.catalogDigest;
  const frame = protocol.parseAmuxV22ReadOnlyApiExecutionFrame({
    version: 1, executorKind: "read_only_api_retry_v1",
    provider: "anthropic", modelId: "claude-opus-5-5",
    routeId: "read-only-route", routePolicyDigest: "d".repeat(64),
    catalogApprovalId: approvalId, catalogVersion: catalog.catalogVersion,
    catalogDigest, pricingVersion: catalog.pricingVersion,
    pricingSource: "approved-catalog",
    pricingVerifiedAt: "2026-10-13T00:00:00.000Z",
    pricingExpiresAt: "2026-10-14T00:00:00.000Z",
    uncachedInputMicroUsdPerMillion: 1_000_000,
    cacheReadMicroUsdPerMillion: 100_000,
    cacheWriteMicroUsdPerMillion: 200_000,
    outputMicroUsdPerMillion: 2_000_000,
    tokenLimits: { uncachedInputTokens: 10, cacheReadTokens: 10,
      cacheWriteTokens: 10, outputTokens: 10 },
    maxProviderTurns: 8, maxOutputTokensPerTurn: 10,
    maxRetries: 0, maximumCostMicroUsd: 33,
    credentialProfileId: "recovery-api-key",
    credentialMetadataDigest: "e".repeat(64),
    executorArtifactDigest: "f".repeat(64),
    settingsDigest: protocol.AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
    repositoryScopeDigest: "1".repeat(64),
    brokerPolicyDigest: protocol.AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
    toolSchemaDigest: protocol.AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  }, { now: endedAt });
  const receipt = (() => {
    const body = {
      version: 1, executorKind: "read_only_api_retry_v1",
      attemptId, invocationId: attemptId,
      selectedModelId: frame.modelId, actualModelId: frame.modelId,
      actualModelUniform: true, providerTurnCount: 2,
      uncachedInputTokens: 3, cacheReadTokens: 4,
      cacheWriteTokens: 5, outputTokens: 6, usageComplete: true,
      terminalStatus: "succeeded",
      apiExecutionFrameDigest:
        protocol.amuxV22ReadOnlyApiExecutionFrameDigest(frame),
      projectedCostMicroUsd: protocol.projectAmuxV22ReadOnlyApiCost(frame, {
        uncachedInputTokens: 3, cacheReadTokens: 4,
        cacheWriteTokens: 5, outputTokens: 6,
      }),
    };
    return { ...body,
      digest: protocol.amuxV22ReadOnlyApiExecutionReceiptDigest(body) };
  })();
  try {
    assert.equal(await prisma.amuxWorkItem.count({ where: { id: taskId } }), 0);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '10000', true)`;
      const latest = await tx.amuxV4TaskCostCatalogApproval.findFirst({
        orderBy: { version: "desc" }, select: { version: true },
      });
      const actorUserId = "synthetic-owner";
      const auditId = await appendSyntheticAdminAudit({
        query: (sql, params = []) => tx.$executeRawUnsafe(sql, ...params),
      }, {
        actorUserId, action: "amux.v4.task_catalog.approve",
        targetType: "AmuxV4TaskCostCatalogApproval", targetId: approvalId,
        summary: "synthetic native API price approval",
      });
      await tx.amuxV4TaskCostCatalogApproval.create({ data: {
        id: approvalId, version: (latest?.version ?? 0) + 1,
        status: "approved", catalogVersion: catalog.catalogVersion,
        pricingVersion: catalog.pricingVersion, catalog,
        catalogDigest, evidenceDigest: "a".repeat(64),
        approvedByUserId: actorUserId, approvalAuditLogId: auditId,
        approvedAt: endedAt,
      } });
      await tx.amuxWorkItem.create({ data: {
        id: taskId, title: "native API writer fixture", status: "doing",
        kind: "code", priority: "p3",
      } });
      await tx.amuxExecutionAttempt.create({ data: {
        id: attemptId, taskId, worker, workerInstanceId: "fixture",
        workerGeneration: 1, taskRevision: 1, attemptNumber: 1,
        startedAt, heartbeatAt: startedAt,
        leaseExpiresAt: new Date(endedAt.getTime() + 60_000),
      } });
      await assert.rejects(usageStore.recordAmuxV22ReadOnlyApiUsage(tx, {
        worker, attemptId, attemptStartedAt: startedAt,
        endedAt, launchScopeDigest: "2".repeat(64), frame, receipt,
      }), /binding_mismatch/);
      assert.equal(await tx.amuxCliUsageEvent.count({
        where: { invocationId: attemptId },
      }), 0);
      assert.equal(await tx.adminAuditLog.count({
        where: { action: "amux.cli_usage.recorded",
          metadata: { path: ["apiExecutionReceiptDigest"],
            equals: receipt.digest } },
      }), 0);
      throw rollback;
    }, { timeout: 30_000 }), (error) => error === rollback);
    assert.equal(await prisma.amuxWorkItem.count({ where: { id: taskId } }), 0);
    assert.equal(await prisma.amuxCliUsageEvent.count({
      where: { invocationId: attemptId },
    }), 0);
    assert.equal(await prisma.amuxV4TaskCostCatalogApproval.count({
      where: { id: approvalId },
    }), 0);
  } finally { await prisma.$disconnect(); }
});

test("native API writer keeps the recovery start price after catalogue advance", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const [{ prisma }, protocol, catalogCore, usageStore] = await Promise.all([
    import("../../lib/prisma.ts"),
    import("../../lib/amux/v22ReadOnlyApiProtocol.mjs"),
    import("../../lib/amux/v4TaskCostCatalogCore.ts"),
    import("../../lib/amux/cliUsageLedgerStore.ts"),
  ]);
  const rollback = new Error("synthetic immutable price rollback");
  const catalogueApprovalId = randomUUID();
  const usageAuditIds = [];
  const invocationIds = [];
  try {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '10000', true)`;
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
      const db = prismaQueryAdapter(tx);
      const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(db, {
        recoveryExecutorKind: "read_only_api_retry_v1",
      });
      await exerciseAmuxV22TaskRecoveryFixture(db, {
        ...seed,
        positiveOnly: true,
        afterReadOnlyAttemptStarted: async (started) => {
          const frame = started.apiExecutionFrame;
          assert.ok(frame);
          const currentCatalog = {
            schemaVersion: 1,
            catalogVersion: `advanced-${randomUUID()}`,
            pricingVersion: "synthetic-price-v2",
            gradeRulesVersion: "grade-v1",
            gradeRules: [{
              role: "investigate", grade: "high",
              caps: { uncachedInputTokens: 10_000,
                cacheReadTokens: 10_000, cacheWriteTokens: 10_000,
                outputTokens: 20_000, maxAttempts: 2 },
            }],
            routes: [{
              routeId: frame.routeId, workerName: started.worker,
              provider: frame.provider, modelId: frame.modelId,
              routePolicyDigest: frame.routePolicyDigest, enabled: true,
              roles: ["investigate"], grades: ["high"],
              pricingSource: "advanced-approved-catalog",
              pricingVerifiedAt: "2027-01-12T00:00:00.000Z",
              pricingExpiresAt: "2028-01-12T00:00:00.000Z",
              uncachedInputMicroUsdPerMillion:
                frame.uncachedInputMicroUsdPerMillion * 2,
              cacheReadMicroUsdPerMillion:
                frame.cacheReadMicroUsdPerMillion * 2,
              cacheWriteMicroUsdPerMillion:
                frame.cacheWriteMicroUsdPerMillion * 2,
              outputMicroUsdPerMillion: frame.outputMicroUsdPerMillion * 2,
              toolCostCapMicroUsdPerAttempt: 0,
            }],
          };
          const inspection = catalogCore.inspectV4TaskCostCatalog(currentCatalog);
          assert.equal(inspection.ok, true);
          const latest = await tx.amuxV4TaskCostCatalogApproval.findFirst({
            orderBy: { version: "desc" }, select: { version: true },
          });
          const catalogAuditId = await appendSyntheticAdminAudit(db, {
            actorUserId: "synthetic-owner",
            action: "amux.v4.task_catalog.approve",
            targetType: "AmuxV4TaskCostCatalogApproval",
            targetId: catalogueApprovalId,
            summary: "synthetic advanced API price approval",
          });
          await tx.amuxV4TaskCostCatalogApproval.create({ data: {
            id: catalogueApprovalId, version: (latest?.version ?? 0) + 1,
            status: "approved", catalogVersion: currentCatalog.catalogVersion,
            pricingVersion: currentCatalog.pricingVersion,
            catalog: currentCatalog,
            catalogDigest: inspection.catalogDigest,
            evidenceDigest: "9".repeat(64),
            approvedByUserId: "synthetic-owner",
            approvalAuditLogId: catalogAuditId,
            approvedAt: started.attemptStartedAt,
          } });
          const receiptBody = {
            version: 1, executorKind: "read_only_api_retry_v1",
            attemptId: started.attemptId, invocationId: started.attemptId,
            selectedModelId: frame.modelId, actualModelId: frame.modelId,
            actualModelUniform: true, providerTurnCount: 2,
            uncachedInputTokens: 3, cacheReadTokens: 4,
            cacheWriteTokens: 5, outputTokens: 6, usageComplete: true,
            terminalStatus: "succeeded",
            apiExecutionFrameDigest:
              protocol.amuxV22ReadOnlyApiExecutionFrameDigest(frame),
            projectedCostMicroUsd:
              protocol.projectAmuxV22ReadOnlyApiCost(frame, {
                uncachedInputTokens: 3, cacheReadTokens: 4,
                cacheWriteTokens: 5, outputTokens: 6,
              }),
          };
          const receipt = { ...receiptBody,
            digest: protocol.amuxV22ReadOnlyApiExecutionReceiptDigest(
              receiptBody) };
          const endedAt = new Date("2027-01-12T00:00:01.000Z");
          assert.ok(endedAt > new Date(frame.pricingExpiresAt));
          const write = () => usageStore.recordAmuxV22ReadOnlyApiUsage(tx, {
            worker: started.worker, attemptId: started.attemptId,
            attemptStartedAt: started.attemptStartedAt, endedAt,
            launchScopeDigest: started.launchScopeDigest, frame, receipt,
          });
          const first = await write();
          invocationIds.push(started.attemptId);
          usageAuditIds.push(first.auditId);
          assert.equal(first.duplicate, false);
          assert.equal(first.receiptDigest, receipt.digest);
          assert.deepEqual(await write(), {
            invocationId: started.attemptId, duplicate: true,
            receiptDigest: receipt.digest, auditId: null,
          });
          const row = await tx.amuxCliUsageEvent.findUniqueOrThrow({
            where: { invocationId: started.attemptId },
            select: { pricingVersion: true, projectedApiCostMicrousd: true,
              actualModelId: true, inputTokens: true, outputTokens: true,
              cacheReadInputTokens: true, cacheCreationInputTokens: true,
              cli: true, source: true, authentication: true,
              status: true, completeness: true },
          });
          assert.equal(row.pricingVersion, frame.pricingVersion);
          assert.equal(row.projectedApiCostMicrousd,
            BigInt(receipt.projectedCostMicroUsd));
          assert.equal(row.actualModelId, frame.modelId);
          assert.equal(row.inputTokens, BigInt(3));
          assert.equal(row.outputTokens, BigInt(6));
          assert.equal(row.cacheReadInputTokens, BigInt(4));
          assert.equal(row.cacheCreationInputTokens, BigInt(5));
          assert.equal(row.cli, "anthropic_api");
          assert.equal(row.source, "anthropic_messages_api");
          assert.equal(row.authentication, "api_key");
          assert.equal(row.status, "succeeded");
          assert.equal(row.completeness, "reported_complete");
          const audit = await tx.adminAuditLog.findUniqueOrThrow({
            where: { id: first.auditId }, select: { metadata: true },
          });
          assert.equal(audit.metadata?.launchScopeDigest,
            started.launchScopeDigest);
          assert.equal(audit.metadata?.apiExecutionFrameDigest,
            receipt.apiExecutionFrameDigest);
          assert.equal(audit.metadata?.apiExecutionReceiptDigest,
            receipt.digest);
          assert.deepEqual(audit.metadata?.apiExecutionReceipt, receipt);
        },
      });
      throw rollback;
    }, { timeout: 30_000 }), (error) => error === rollback);
    assert.equal(await prisma.amuxCliUsageEvent.count({
      where: { invocationId: { in: invocationIds } },
    }), 0);
    assert.equal(await prisma.amuxV4TaskCostCatalogApproval.count({
      where: { id: catalogueApprovalId },
    }), 0);
    assert.equal(await prisma.adminAuditLog.count({
      where: { id: { in: usageAuditIds.filter(Boolean) } },
    }), 0);
  } finally { await prisma.$disconnect(); }
});
