import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog, writeSystemAuditLog } from
  "@/lib/adminAudit";
import { auditRowActorKind,
  AMUX_V19_SYSTEM_REGISTRATION_ACTION,
  AMUX_V19_SYSTEM_REGISTRATION_TARGET } from
  "@/lib/adminAuditSystemActors";
import { commitAmuxIdeaAnalysisBudgetReservation } from
  "@/lib/amux/ideaAnalysisBudgetReservationService";
import { commitAnalysisBudgetSetting, readAnalysisMonthlyBudgetSetting } from
  "@/lib/amux/ideaAnalysisBudgetSettingStore";
import { commitAmuxIdeaOnlyAnalysisClaim } from
  "@/lib/amux/ideaAnalysisClaimService";
import { commitAmuxIdeaAnalysisResult } from
  "@/lib/amux/ideaAnalysisResultService";
import { commitAmuxIdeaAnalysisPriceApproval,
  commitAmuxIdeaAnalysisPriceRevocation } from
  "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { inspectV4TaskCostCatalog } from
  "@/lib/amux/v4TaskCostCatalogCore";
import { commitFrontierCatalogDecision } from
  "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from
  "@/lib/amux/ideaFrontierCatalogWriteCore";
import { listApprovedAmuxIdeaFrontierModels } from
  "@/lib/amux/ideaFrontierCatalogRead";
import { createAmuxContentKeyRing, createAmuxContentUnitKeys } from
  "@/lib/amux/ideaKeyStore";
import { loadCurrentAmuxContentKeys } from "@/lib/amux/ideaKeyConfig";
import { createInitialIdeaOnlySourcePlan } from
  "@/lib/amux/ideaInitialSourcePlanService";
import { commitAmuxOperatingScope, readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority } from
  "@/lib/amux/ideaOperatingScopeStore";
import { inspectAmuxIdeaSessionSubmission } from
  "@/lib/amux/ideaSessionSubmissionCore";
import { commitAmuxIdeaSessionSubmission as commitPinnedSessionSubmission } from
  "@/lib/amux/ideaSessionSubmissionService";
import { commitAmuxV19CompletedIdeaSystemRegistrationForTest,
  readAmuxV19SystemRegistration } from
  "@/lib/amux/ideaSystemRegistrationService";
import { AmuxV20RegistrationRefusalStoreError,
  recordAmuxV20RegistrationRefusal } from
  "@/lib/amux/ideaRegistrationRefusalService";
import { AMUX_V20_REGISTRATION_REFUSAL_ACTION,
  AMUX_V20_REGISTRATION_REFUSAL_SUMMARY,
  AMUX_V20_REGISTRATION_REFUSAL_TARGET } from
  "@/lib/amux/ideaRegistrationRefusalCore";
import { AmuxIdeaUnitProposalReadError } from
  "@/lib/amux/ideaUnitProposalReadService";
import { writeAmuxPortfolioAssessmentInTx } from
  "@/lib/amux/portfolioAssessmentService";
import { amuxAnalysisFreeformSubjectId } from
  "@/lib/amux/ideaAnalysisDraftSealCore";
import { commitIdeaOnlyTransferPreview } from
  "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation } from
  "@/lib/amux/ideaTransferConfirmationService";
import { amuxSessionPageKeyIdentities,
  commitAmuxSessionAnalysisPlanInTx, readAmuxSessionPageContextInTx } from
  "@/lib/amux/ideaSessionAnalysisPlanService";
import { prisma } from "@/lib/prisma";

const commitAmuxIdeaSessionSubmission = (
  tx: Parameters<typeof commitPinnedSessionSubmission>[0],
  input: Omit<Parameters<typeof commitPinnedSessionSubmission>[1], "pinnedCommitShas">,
) => commitPinnedSessionSubmission(tx, { ...input,
  pinnedCommitShas: Array(input.inspected.counts.repositoryCount +
    input.inspected.counts.pullRequestCount).fill("a".repeat(40)) });

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v19 system registration test requires a dedicated loopback test database");
}

process.env.ADMIN_AUDIT_INTEGRITY_KEY =
  "synthetic-amux-intake-operating-scope-audit-key-2026";
Object.assign(process.env, { NODE_ENV: "test" });
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = "synthetic-system-registration";
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = "1";
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = randomBytes(32).toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = "synthetic-system-registration-digest";
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = randomBytes(32).toString("base64");
process.env.AMUX_V4_KEY_STORE_BUCKET = "amux-system-registration-test";
process.env.AMUX_V4_KEY_STORE_REGION = "test-region";
process.env.AMUX_V4_KEY_STORE_ACCESS_KEY_ID = "synthetic-access";
process.env.AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY = "synthetic-secret";
process.env.AMUX_V4_KEY_STORE_URL_STYLE = "path";

const objects = new Map<string, Buffer>();
let server: Server;
let authority: AmuxOperatingScopeAuthority;
let session: Session;
let request: Request;
let registeredSystemDecisionId: string;
let registeredSystemDecisionAuditId: string;
let registeredSystemIdeaId: string;
let registeredSystemIdeaPreviewId: string;
let registeredSystemIdeaUnitIds: string[];
let registeredTaskTitle: string;

const listen = (server: Server) => new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});

async function ensureOperatingScope() {
  const current = await prisma.$transaction((tx) =>
    readAmuxOperatingScopeAuthority(tx));
  if (current) return current;
  const ownerId = `synthetic-system-owner-${randomUUID()}`;
  const ownerEmail = "amux-system-registration-owner@example.test";
  process.env.ADMIN_USER_IDS = ownerId;
  process.env.ADMIN_EMAILS = ownerEmail;
  process.env.ADMIN_OWNER_EMAILS = ownerEmail;
  session = { user: { id: ownerId, email: ownerEmail,
    authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
  request = new Request("https://tomverse.test/api/admin/amux/ideas", {
    method: "POST", headers: { "user-agent": "synthetic-system-registration" },
  });
  const modelId = `synthetic-system-model-${randomUUID()}`;
  const frontier = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: randomUUID(),
    provider: "openai", modelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontier.ok) throw new Error(frontier.code);
  await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx,
    { session, request, decision: frontier.request }));
  await prisma.$transaction((tx) => commitAmuxOperatingScope(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: 0,
    scope: { repositories: ["mposition/Tomverse"], model: { provider: "openai", modelId,
      reasoningEffort: "high" } }, ownerConfirmed: true,
  }));
  const saved = await prisma.$transaction((tx) =>
    readAmuxOperatingScopeAuthority(tx));
  if (!saved) throw new Error("synthetic operating scope missing");
  return saved;
}

before(async () => {
  server = createServer(async (incoming, response) => {
    const incomingUrl = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const key = incomingUrl.pathname;
    if (incoming.method === "PUT") {
      if (objects.has(key)) { response.writeHead(412); response.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      response.writeHead(200, { ETag: '"synthetic"' }); response.end();
    } else if (incoming.method === "GET") {
      const value = objects.get(key);
      if (!value) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "Content-Length": value.length,
        "Content-Type": "application/octet-stream" }); response.end(value);
    } else if (incoming.method === "HEAD") {
      response.writeHead(objects.has(key) ? 200 : 404); response.end();
    } else { response.writeHead(405); response.end(); }
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.AMUX_V4_KEY_STORE_ENDPOINT = `http://127.0.0.1:${address.port}`;
  authority = await ensureOperatingScope();
  const ownerEmail = "amux-system-registration-owner@example.test";
  process.env.ADMIN_USER_IDS = authority.approvedByUserId;
  process.env.ADMIN_EMAILS = ownerEmail;
  process.env.ADMIN_OWNER_EMAILS = ownerEmail;
  session = { user: { id: authority.approvedByUserId, email: ownerEmail,
    authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
  request = new Request("https://tomverse.test/api/admin/amux/ideas", {
    method: "POST", headers: { "user-agent": "synthetic-system-registration" },
  });
  // The session-budget suite deliberately leaves a US$0.01 owner setting in
  // this shared test database. This suite needs its own explicit fixture.
  const budget = await prisma.$transaction((tx) =>
    readAnalysisMonthlyBudgetSetting(tx));
  await prisma.$transaction((tx) => commitAnalysisBudgetSetting(tx, {
    session, request, id: randomUUID(), expectedPreviousVersion: budget.version,
    monthlyUsd: "100.00", ownerConfirmed: true,
  }));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
  for (const value of objects.values()) value.fill(0);
  objects.clear();
  await prisma.$disconnect();
});

async function approveSyntheticTaskCatalog() {
  const now = Date.now();
  const catalog = {
    schemaVersion: 1, catalogVersion: `system-catalog-${randomUUID()}`,
    pricingVersion: "synthetic-pricing-v1", gradeRulesVersion: "synthetic-grades-v1",
    gradeRules: [{ role: "implement", grade: "frontier",
      caps: { uncachedInputTokens: 1_000, outputTokens: 1_000,
        cacheReadTokens: 500, cacheWriteTokens: 500, maxAttempts: 2 } }],
    routes: [{ routeId: "synthetic/implement", workerName: "synthetic-worker",
      provider: "openai", modelId: "synthetic-frontier", routePolicyDigest: "d".repeat(64),
      enabled: true, roles: ["implement"], grades: ["frontier"],
      pricingSource: "synthetic-test", pricingVerifiedAt:
        new Date(now - 60_000).toISOString(),
      pricingExpiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
      uncachedInputMicroUsdPerMillion: 1_000_000,
      cacheReadMicroUsdPerMillion: 100_000,
      cacheWriteMicroUsdPerMillion: 150_000,
      outputMicroUsdPerMillion: 2_000_000,
      toolCostCapMicroUsdPerAttempt: 0 }],
  };
  const inspected = inspectV4TaskCostCatalog(catalog);
  assert.equal(inspected.ok, true);
  if (!inspected.ok) throw new Error("synthetic Task catalog rejected");
  await prisma.$transaction(async (tx) => {
    const latest = await tx.amuxV4TaskCostCatalogApproval.findFirst({
      orderBy: { version: "desc" }, select: { version: true } });
    const id = randomUUID();
    const auditId = await writeAdminAuditLog({ tx, session, request,
      action: "amux.v4.task_catalog.approve",
      targetType: "AmuxV4TaskCostCatalogApproval", targetId: id,
      summary: "Approved one synthetic current Task catalog for system registration testing.",
      metadata: { synthetic: true } });
    await tx.amuxV4TaskCostCatalogApproval.create({ data: { id,
      version: (latest?.version ?? 0) + 1, status: "approved",
      catalogVersion: catalog.catalogVersion,
      pricingVersion: catalog.pricingVersion,
      catalog: catalog as Prisma.InputJsonValue,
      catalogDigest: inspected.catalogDigest, evidenceDigest: "e".repeat(64),
      approvedByUserId: authority.approvedByUserId,
      approvalAuditLogId: auditId, approvedAt: new Date(),
    } });
  });
}

async function completedSessionIdea(options: {
  expectedPaths?: string[];
  taskTitle?: string;
} = {}) {
  const initialObjectKeys = new Set(objects.keys());
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1,
    requestId: ideaId, input: { version: 1,
      idea: `Synthetic system registration ${ideaId}`,
      repositories: [], pullRequests: [] },
    source: { toolName: "synthetic", modelProvider: "synthetic",
      sessionDisplay: "system registration DB test" },
  });
  if (!inspected.ok) throw new Error(inspected.code);
  const rawIdentity = { ideaId, purpose: "idea_raw" as const, subjectId: ideaId };
  const rawKeys = await createAmuxContentUnitKeys(rawIdentity);
  await prisma.$transaction((tx) => commitAmuxIdeaSessionSubmission(tx, {
    inspected, expectedAuthority: authority, ideaId, keys: rawKeys,
  }));
  const plan = await prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { actorUserId: authority.approvedByUserId,
      ideaId, keys: rawKeys }));
  const available = await listApprovedAmuxIdeaFrontierModels();
  if (available.decision !== "catalog_current") throw new Error(available.reason);
  const selected = available.models.find((entry) =>
    entry.provider === authority.scope.model.provider &&
    entry.modelId === authority.scope.model.modelId &&
    entry.allowedEfforts.includes(authority.scope.model.reasoningEffort));
  if (!selected) throw new Error("scope model approval missing");
  const previewId = randomUUID();
  const transferIdentity = { ideaId, purpose: "transfer_payload" as const,
    subjectId: previewId };
  await createAmuxContentUnitKeys(transferIdentity);
  const transferKeys = await createAmuxContentKeyRing(
    [rawIdentity, transferIdentity], []);
  const browserNonce = randomBytes(32).toString("base64url");
  const v4Provider = authority.scope.model.provider;
  if (v4Provider !== "openai" && v4Provider !== "anthropic") {
    throw new Error("The v4 transfer fixture needs an OpenAI or Anthropic scope model");
  }
  const choice = { previewId, ideaId,
    provider: v4Provider,
    modelId: authority.scope.model.modelId,
    reasoningEffort: authority.scope.model.reasoningEffort,
    approvalId: selected.approvalId, approvalVersion: selected.approvalVersion };
  const prepared = await prisma.$transaction((tx) =>
    commitIdeaOnlyTransferPreview(tx, { session, request, choice,
      keys: transferKeys, browserNonce }));
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx, {
    session, request, keys: transferKeys, browserNonce,
    choice: { previewId, ideaId, payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId },
  }));
  const currentPrice = await prisma.amuxIdeaAnalysisPriceVersion.findFirst({
    where: { provider: authority.scope.model.provider,
      modelId: authority.scope.model.modelId, mode: "subscription_cli" },
    orderBy: { version: "desc" }, select: { id: true, version: true,
      status: true, expiresAt: true, inputTokensCap: true, outputTokensCap: true },
  });
  // Another suite sharing this database may have approved a tighter price
  // for the same model; reuse only one whose caps cover this fixture's usage.
  let priceVersionId = currentPrice?.status === "approved" &&
    currentPrice.expiresAt > new Date() && currentPrice.inputTokensCap >= 1_000 &&
    currentPrice.outputTokensCap >= 2_000 ? currentPrice.id : null;
  if (!priceVersionId && currentPrice?.status === "approved") {
    // A newer version needs the tighter one revoked first.
    await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceRevocation(tx, {
      session, request, priceVersionId: currentPrice.id,
      expectedVersion: currentPrice.version }));
  }
  if (!priceVersionId) {
    priceVersionId = randomUUID();
    await prisma.$transaction((tx) => commitAmuxIdeaAnalysisPriceApproval(tx, {
      session, request, approval: { id: priceVersionId!,
        provider: authority.scope.model.provider,
        modelId: authority.scope.model.modelId, mode: "subscription_cli",
        expectedPreviousVersion: currentPrice?.version ?? 0,
        inputTokensCap: 1_000, outputTokensCap: 2_000,
        inputMicroUsdPerMillion: 1_000_000,
        outputMicroUsdPerMillion: 2_000_000,
        evidenceDigest: randomBytes(32).toString("hex"),
        ownerConfirmedWorstTier: true,
        verifiedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
    }));
  }
  const holdId = randomUUID();
  await prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx, {
    session, request, holdId, previewId, priceVersionId,
    runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
    keys: transferKeys,
  }));
  const claim = await prisma.$transaction((tx) =>
    commitAmuxIdeaOnlyAnalysisClaim(tx,
      { requestId: randomUUID(), previewId, keys: transferKeys }));
  const unitIds = Array.from({ length: 4 }, () => randomUUID());
  const resultKeys = await createAmuxContentKeyRing([transferIdentity], [
    ...unitIds.map((subjectId) => ({ ideaId,
      purpose: "analysis_draft" as const, subjectId })),
    { ideaId, purpose: "analysis_freeform" as const,
      subjectId: amuxAnalysisFreeformSubjectId(ideaId, previewId) },
  ]);
  const signal = (metrics: Record<string, number>) => ({ metrics,
    uncertainty: "low", rationale: "Synthetic deterministic evidence.",
    evidenceRefIds: ["operator_idea"] });
  const units = [
    { kind: "node", localId: "c0:node-0", level: "initiative", parentRef: null,
      title: `Synthetic initiative ${ideaId}`, description: "System registration fixture.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 3 }) },
    { kind: "node", localId: "c0:node-1", level: "epic", parentRef: "c0:node-0",
      title: `Synthetic epic ${ideaId}`, description: "System registration fixture.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 3 }) },
    { kind: "node", localId: "c0:node-2", level: "feature", parentRef: "c0:node-1",
      title: `Synthetic feature ${ideaId}`, description: "System registration fixture.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 3 }) },
    { kind: "card", localId: "c0:card-0", cardType: "task", storyKind: null,
      title: options.taskTitle ?? `Synthetic Task ${ideaId}`,
      problem: "Register one bounded plan.",
      scopeIn: ["Register this fixture"], scopeOut: ["Do not execute it"],
      completionCriteria: ["The inert Task is auditable"],
      featureRef: "c0:node-2",
      parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
      taskRole: "implement", executionGrade: "advanced",
      expectedPaths: options.expectedPaths ??
        ["lib/amux/ideaSystemRegistrationCore.ts"],
      executionBrief: "Implement and verify one bounded contract change.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ contribution: 3,
        urgency: 2, dependencyUnlock: 2, workerCoverage: 2, effort: 2,
        deliveryRisk: 1 }) },
  ];
  const rawModelOutput = JSON.stringify({ schemaVersion: 5, previewId,
    chunkIndex: 0, outcome: "propose", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "One synthetic system registration plan was analyzed.",
    remainingScope: null, units });
  const saved = await prisma.$transaction((tx) => commitAmuxIdeaAnalysisResult(tx, {
    requestId: randomUUID(), ideaId, previewId, holdId,
    leaseGeneration: claim.leaseGeneration, outcome: "verified_success",
    rawModelOutput, inputTokens: 100, outputTokens: 50,
    keys: resultKeys, unitIds,
  }), { timeout: 30_000 });
  assert.equal(saved.state, "draft_ready");
  assert.equal(plan.revisionId, (await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: ideaId }, select: { currentSourcePlanRevisionId: true },
  })).currentSourcePlanRevisionId);
  return { ideaId, previewId, unitIds, taskTitle: units[3]!.title,
    objectKeys: [...objects.keys()].filter((key) => !initialObjectKeys.has(key)) };
}

test("one completed session plan registers atomically under system evidence", async () => {
  await approveSyntheticTaskCatalog();
  const { ideaId, previewId, unitIds, taskTitle } = await completedSessionIdea();
  const before = {
    decisions: await prisma.amuxIdeaUnitDecision.count({ where: { ideaId } }),
    cards: await prisma.amuxWorkItem.count({ where: {
      sourceSystem: "admin-idea-v4", sourceKey: { in: unitIds } } }),
  };
  assert.deepEqual(before, { decisions: 0, cards: 0 });
  const result = await commitAmuxV19CompletedIdeaSystemRegistrationForTest(ideaId);
  assert.equal(result.state, "committed");
  if (result.state !== "committed") throw new Error("system registration refused");
  const decisions = await prisma.amuxIdeaUnitDecision.findMany({ where: { ideaId },
    orderBy: { preparedAt: "asc" } });
  const nodeIds = decisions.flatMap((entry) =>
    entry.resolvedNodeId ? [entry.resolvedNodeId] : []);
  const cardIds = decisions.flatMap((entry) =>
    entry.registeredWorkItemId ? [entry.registeredWorkItemId] : []);
  assert.deepEqual({ nodes: nodeIds.length, cards: cardIds.length },
    { nodes: 3, cards: 1 });
  const [idea, task, audit, score, assessmentCount] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } }),
    prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: cardIds[0]! } }),
    prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } }),
    prisma.amuxPortfolioScoreSnapshot.findFirstOrThrow({
      where: { taskId: cardIds[0]! } }),
    prisma.amuxPortfolioAssessment.count({ where: { OR: [
      { nodeId: { in: nodeIds } }, { cardId: { in: cardIds } },
    ] } }),
  ]);
  assert.equal(idea.state, "completed");
  assert.equal(idea.systemRegistrationAuditLogId, result.auditId);
  assert.equal(task.status, "backlog");
  assert.equal(task.owner, null);
  assert.equal(task.claimedAt, null);
  assert.equal(decisions.length, 4);
  assert.equal(decisions.every((entry) => entry.state === "consumed"), true);
  const systemDecision = decisions.find((entry) =>
    entry.registeredWorkItemId === task.id);
  assert.ok(systemDecision?.finalAuditLogId);
  registeredSystemDecisionId = systemDecision.id;
  registeredSystemDecisionAuditId = systemDecision.finalAuditLogId;
  registeredSystemIdeaId = ideaId;
  registeredSystemIdeaPreviewId = previewId;
  registeredSystemIdeaUnitIds = unitIds;
  registeredTaskTitle = taskTitle;
  const taskSnapshot = decisions.find((entry) =>
    entry.registeredWorkItemId === task.id)?.confirmationSnapshot as
      { card?: { task?: { proposedGrade?: string; grade?: string;
        publicPrDisclosureApproved?: boolean } } } | undefined;
  assert.deepEqual(taskSnapshot?.card?.task && {
    proposed: taskSnapshot.card.task.proposedGrade,
    final: taskSnapshot.card.task.grade,
  }, { proposed: "advanced", final: "frontier" });
  assert.equal(taskSnapshot?.card?.task?.publicPrDisclosureApproved, true);
  assert.equal(score.taskId, task.id);
  assert.equal(assessmentCount, 4);
  assert.equal(auditRowActorKind(audit), "system");
  assert.deepEqual(audit.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata) ? {
      operatingScopeSettingId: audit.metadata.operatingScopeSettingId,
      operatingScopeApprovalAuditLogId:
        audit.metadata.operatingScopeApprovalAuditLogId,
    } : null, {
      operatingScopeSettingId: authority.settingId,
      operatingScopeApprovalAuditLogId: (await prisma
        .amuxIdeaOperatingScopeSetting.findUniqueOrThrow({ where: {
          id: authority.settingId,
        } })).approvalAuditLogId,
    });
  assert.equal(JSON.stringify(audit.metadata).includes("lib/amux"), false);
  assert.deepEqual(await readAmuxV19SystemRegistration(ideaId), {
    state: "committed", retryWrite: false, ideaId, auditId: result.auditId,
  });
  const lateRefusalRequestId = randomUUID();
  await assert.rejects(recordAmuxV20RegistrationRefusal({
    systemActor: "amux-v4-intake", actorUserId: authority.approvedByUserId,
    requestId: lateRefusalRequestId, attemptKind: "whole_plan",
    refusalCode: "plan_schema_invalid", ideaId,
    draftUnitId: unitIds[3]!, analysisPreviewId: previewId,
    proposedExecutionGrade: null, finalExecutionGrade: null,
  }), (error: unknown) =>
    error instanceof AmuxV20RegistrationRefusalStoreError &&
    error.code === "integrity_unavailable");
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({ where: {
    requestId: lateRefusalRequestId,
  } }), 0);
  const priorTaskAssessment = await prisma.amuxPortfolioAssessment.findFirstOrThrow({
    where: { cardId: task.id }, orderBy: { assessmentVersion: "desc" },
    select: { metrics: true, uncertainty: true },
  });
  const later = await prisma.$transaction((tx) =>
    writeAmuxPortfolioAssessmentInTx(tx, {
      session, request, digestKey: loadCurrentAmuxContentKeys(process.env),
      confirmationDigest: null,
      payload: { id: randomUUID(), requestId: randomUUID(),
        subject: { kind: "task", id: task.id },
        metrics: priorTaskAssessment.metrics,
        uncertainty: priorTaskAssessment.uncertainty as "low" | "medium" | "high",
        evidenceRefs: ["manual:readback"],
        evidenceAsOf: new Date(Date.now() - 1_000).toISOString(),
        reasonCode: "new_evidence", modelProposalDigest: null },
    }));
  const laterAudit = await prisma.adminAuditLog.findUniqueOrThrow({ where: {
    id: later.auditId,
  } });
  assert.equal(auditRowActorKind(laterAudit), "human");
  assert.equal(await prisma.amuxPortfolioAssessment.count({ where: {
    cardId: task.id,
  } }), 2);
  assert.deepEqual(await readAmuxV19SystemRegistration(ideaId), {
    state: "committed", retryWrite: false, ideaId, auditId: result.auditId,
  });
});

/** A session idea analysing on its own: no owner preview, no confirmation,
 * no v4 budget hold. Each page is one claim-bound CLI answer. */
async function analysingSessionIdea() {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1,
    requestId: ideaId, input: { version: 1,
      idea: `Synthetic session plan ${ideaId}`,
      repositories: [], pullRequests: [] },
    source: { toolName: "synthetic", modelProvider: "synthetic",
      sessionDisplay: "session plan DB test" },
  });
  if (!inspected.ok) throw new Error(inspected.code);
  const rawIdentity = { ideaId, purpose: "idea_raw" as const, subjectId: ideaId };
  const rawKeys = await createAmuxContentUnitKeys(rawIdentity);
  const submitted = await prisma.$transaction((tx) =>
    commitAmuxIdeaSessionSubmission(tx, { inspected,
      expectedAuthority: authority, ideaId, keys: rawKeys }));
  await prisma.amuxIdeaSubmission.update({ where: { id: ideaId },
    data: { state: "analyzing" } });
  assert.ok(submitted.auditId);
  return { ideaId, rawIdentity };
}

/** One page answer, keyed the way the result route keys it. */
async function sessionPageAnswer(idea: Awaited<ReturnType<typeof analysingSessionIdea>>,
  rawPage: (previewId: string) => { units: unknown[] }) {
  const claimId = randomUUID();
  const page = rawPage(claimId);
  const unitIds = page.units.map(() => randomUUID());
  const keys = await createAmuxContentKeyRing([idea.rawIdentity,
    ...await amuxSessionPageKeyIdentities(prisma, idea.ideaId)], [
    { ideaId: idea.ideaId, purpose: "transfer_payload" as const,
      subjectId: claimId },
    { ideaId: idea.ideaId, purpose: "analysis_freeform" as const,
      subjectId: amuxAnalysisFreeformSubjectId(idea.ideaId, claimId) },
    ...unitIds.map((subjectId) => ({ ideaId: idea.ideaId,
      purpose: "analysis_draft" as const, subjectId }))]);
  const planned = await prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    // Each result has its own audit; the result commit itself is covered by
    // the session submission suite, so a per-page stand-in id is enough here.
    return commitAmuxSessionAnalysisPlanInTx(tx, { ideaId: idea.ideaId,
      claimId, resultAuditId: `synthetic-result-${claimId}`,
      modelId: authority.scope.model.modelId,
      rawModelOutput: JSON.stringify(page), keys, unitIds });
  }, { timeout: 30_000 });
  return { claimId, unitIds, planned, keys };
}

async function sessionPlannedIdea(rawPage: (previewId: string) => { units: unknown[] }) {
  const idea = await analysingSessionIdea();
  return { ideaId: idea.ideaId, ...await sessionPageAnswer(idea, rawPage) };
}

const sessionPage = (units: unknown[], extra: Record<string, unknown> = {}) =>
  (previewId: string) => ({ schemaVersion: 5, previewId, chunkIndex: 0,
    outcome: "propose", coverageStatus: "complete", continuationKind: null,
    ownerQuestion: null, coveredScope: "One synthetic session plan was analyzed.",
    remainingScope: null, units, ...extra });

function sessionPlanUnits(title: string) {
  const signal = (metrics: Record<string, number>) => ({ metrics,
    uncertainty: "low", rationale: "Synthetic deterministic evidence.",
    evidenceRefIds: ["operator_idea"] });
  return [
    { kind: "node", localId: "c0:node-0", level: "initiative", parentRef: null,
      title: `${title} initiative`, description: "Session plan fixture.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 3 }) },
    { kind: "node", localId: "c0:node-1", level: "epic", parentRef: "c0:node-0",
      title: `${title} epic`, description: "Session plan fixture.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 3 }) },
    { kind: "node", localId: "c0:node-2", level: "feature", parentRef: "c0:node-1",
      title: `${title} feature`, description: "Session plan fixture.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ value: 3 }) },
    { kind: "card", localId: "c0:card-0", cardType: "task", storyKind: null,
      title: `${title} Task`, problem: "Register one session plan.",
      scopeIn: ["Register this fixture"], scopeOut: ["Do not execute it"],
      completionCriteria: ["The inert Task is auditable"],
      featureRef: "c0:node-2", parentStoryRef: null, dependencyRefs: [],
      duplicateCandidateRefs: [], taskRole: "implement",
      executionGrade: "advanced",
      expectedPaths: ["lib/amux/ideaSessionAnalysisPlanService.ts"],
      executionBrief: "Implement and verify one bounded change.",
      sourceRefIds: ["operator_idea"], portfolioSignal: signal({ contribution: 3,
        urgency: 2, dependencyUnlock: 2, workerCoverage: 2, effort: 2,
        deliveryRisk: 1 }) },
  ];
}

test("a session CLI answer becomes a plan the system registration accepts", async () => {
  await approveSyntheticTaskCatalog();
  const title = `Synthetic session ${randomUUID()}`;
  const { ideaId, claimId, unitIds, planned } = await sessionPlannedIdea(
    sessionPage(sessionPlanUnits(title)));
  assert.equal(planned.state, "plan_ready");
  if (planned.state !== "plan_ready") throw new Error("session plan refused");
  assert.equal(planned.unitCount, 4);
  const [idea, chunk, preview] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } } }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({ where: { id: claimId } }),
  ]);
  assert.equal(idea.state, "awaiting_owner");
  assert.equal(idea.currentSourcePlanRevisionId, planned.planId);
  assert.equal(chunk.state, "draft_ready");
  assert.equal(chunk.currentPreviewId, claimId);
  assert.equal(preview.state, "completed");
  // The page prompt is stored as the preview payload a next page reads.
  assert.ok(preview.payloadCiphertext && preview.payloadPurgeAfter);
  const result = await commitAmuxV19CompletedIdeaSystemRegistrationForTest(ideaId);
  assert.equal(result.state, "committed");
  const decisions = await prisma.amuxIdeaUnitDecision.findMany({
    where: { ideaId }, select: { draftUnitId: true, sourcePreviewId: true,
      registeredWorkItemId: true } });
  assert.equal(decisions.length, 4);
  assert.ok(decisions.every((entry) => entry.sourcePreviewId === claimId));
  assert.deepEqual(new Set(decisions.map((entry) => entry.draftUnitId)),
    new Set(unitIds));
  assert.equal(decisions.filter((entry) => entry.registeredWorkItemId).length, 1);
  assert.equal((await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: ideaId }, select: { state: true } })).state, "completed");
});

test("a session plan continues on its next page and registers once complete", async () => {
  await approveSyntheticTaskCatalog();
  const title = `Synthetic two-page session ${randomUUID()}`;
  const signal = (metrics: Record<string, number>) => ({ metrics,
    uncertainty: "low", rationale: "Synthetic deterministic evidence.",
    evidenceRefIds: ["operator_idea"] });
  const nodes = sessionPlanUnits(title).slice(0, 3);
  const stories = Array.from({ length: 8 }, (_, index) => ({
    kind: "card", localId: `c0:card-${index}`, cardType: "story",
    storyKind: "general", title: `${title} story ${index}`,
    problem: "The idea holds more than eight independent cards.",
    scopeIn: ["Review this story"], scopeOut: ["Do not execute"],
    completionCriteria: ["The owner can review the result"],
    featureRef: "c0:node-2", parentStoryRef: null, dependencyRefs: [],
    duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
    executionBrief: null, sourceRefIds: ["operator_idea"],
    portfolioSignal: signal({ impact: 2 }) }));
  const idea = await analysingSessionIdea();
  const first = await sessionPageAnswer(idea, (previewId) => ({ schemaVersion: 5,
    previewId, chunkIndex: 0, outcome: "propose", coverageStatus: "more",
    continuationKind: "output", ownerQuestion: null,
    coveredScope: "Eight independently reviewable stories were proposed.",
    remainingScope: "One implementation Task remains for the same feature.",
    units: [...nodes, ...stories] }));
  assert.equal(first.planned.state, "plan_continues");
  assert.equal((await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: idea.ideaId }, select: { state: true } })).state, "analyzing",
  "the queue claims the next page; nobody approves it");
  assert.equal((await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId: idea.ideaId, chunkIndex: 1 } },
    select: { state: true } })).state, "pending");
  // The next page sees the earlier page's scope and references.
  const keys = await createAmuxContentKeyRing([idea.rawIdentity,
    ...await amuxSessionPageKeyIdentities(prisma, idea.ideaId)], []);
  const context = await prisma.$transaction(async (tx) => {
    const row = await tx.amuxIdeaSubmission.findUniqueOrThrow({
      where: { id: idea.ideaId },
      select: { actorUserId: true, currentSourcePlanRevisionId: true } });
    return readAmuxSessionPageContextInTx(tx, { ideaId: idea.ideaId,
      actorUserId: row.actorUserId, planId: row.currentSourcePlanRevisionId,
      now: new Date(), keys });
  });
  assert.equal(context.chunkIndex, 1);
  assert.equal(context.continuation?.remainingScope,
    "One implementation Task remains for the same feature.");
  assert.ok(context.permittedTargetRefs.some((ref) => ref.ref === "c0:card-7"));
  assert.ok(context.permittedTargetRefs.some((ref) => ref.ref === "c0:node-2"));
  const second = await sessionPageAnswer(idea, (previewId) => ({ schemaVersion: 5,
    previewId, chunkIndex: 1, outcome: "propose", coverageStatus: "complete",
    continuationKind: null, ownerQuestion: null,
    coveredScope: "The remaining implementation Task was proposed.",
    remainingScope: null,
    units: [{ ...sessionPlanUnits(title)[3]!, localId: "c1:card-0" }] }));
  assert.equal(second.planned.state, "plan_ready");
  assert.equal((await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: idea.ideaId }, select: { state: true } })).state, "awaiting_owner");
  const result = await commitAmuxV19CompletedIdeaSystemRegistrationForTest(idea.ideaId);
  assert.equal(result.state, "committed");
  const decisions = await prisma.amuxIdeaUnitDecision.findMany({
    where: { ideaId: idea.ideaId }, select: { sourcePreviewId: true,
      registeredWorkItemId: true } });
  assert.equal(decisions.length, 12);
  assert.deepEqual(new Set(decisions.map((entry) => entry.sourcePreviewId)),
    new Set([first.claimId, second.claimId]));
  assert.equal(decisions.filter((entry) => entry.registeredWorkItemId).length, 9);
});

test("a refused later page ends every earlier page's body clock", async () => {
  const title = `Synthetic parked session ${randomUUID()}`;
  const signal = (metrics: Record<string, number>) => ({ metrics,
    uncertainty: "low", rationale: "Synthetic deterministic evidence.",
    evidenceRefIds: ["operator_idea"] });
  const stories = Array.from({ length: 8 }, (_, index) => ({
    kind: "card", localId: `c0:card-${index}`, cardType: "story",
    storyKind: "general", title: `${title} story ${index}`,
    problem: "The idea holds more than eight independent cards.",
    scopeIn: ["Review this story"], scopeOut: ["Do not execute"],
    completionCriteria: ["The owner can review the result"],
    featureRef: "c0:node-2", parentStoryRef: null, dependencyRefs: [],
    duplicateCandidateRefs: [], taskRole: null, executionGrade: null,
    executionBrief: null, sourceRefIds: ["operator_idea"],
    portfolioSignal: signal({ impact: 2 }) }));
  const idea = await analysingSessionIdea();
  const first = await sessionPageAnswer(idea, (previewId) => ({ schemaVersion: 5,
    previewId, chunkIndex: 0, outcome: "propose", coverageStatus: "more",
    continuationKind: "output", ownerQuestion: null,
    coveredScope: "Eight independently reviewable stories were proposed.",
    remainingScope: "One implementation Task remains for the same feature.",
    units: [...sessionPlanUnits(title).slice(0, 3), ...stories] }));
  assert.equal(first.planned.state, "plan_continues");
  const before = await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId: idea.ideaId, chunkIndex: 0 } },
    select: { freeformPurgeAfter: true } });
  assert.ok(before.freeformPurgeAfter && before.freeformPurgeAfter > new Date(),
    "a continuing page keeps its body for the next page");
  const second = await sessionPageAnswer(idea, () => ({ units: [] }));
  assert.deepEqual(second.planned, { state: "plan_refused", reason: "invalid_result" });
  const [idea0, chunk0, preview0] = await Promise.all([
    prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: idea.ideaId },
      select: { state: true, analysisCompletedAt: true } }),
    prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
      where: { ideaId_chunkIndex: { ideaId: idea.ideaId, chunkIndex: 0 } },
      select: { freeformPurgeAfter: true } }),
    prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
      where: { id: first.claimId }, select: { payloadPurgeAfter: true } }),
  ]);
  assert.equal(idea0.state, "awaiting_owner");
  assert.ok(idea0.analysisCompletedAt);
  assert.ok(chunk0.freeformPurgeAfter! <= idea0.analysisCompletedAt);
  assert.ok(preview0.payloadPurgeAfter! <= idea0.analysisCompletedAt);
});

test("a session answer that asks the owner leaves the queue without a plan", async () => {
  const { ideaId, planned } = await sessionPlannedIdea(sessionPage([], {
    outcome: "needs_information", coverageStatus: "needs_owner_input",
    continuationKind: "input",
    ownerQuestion: "Which repository owns this change?" }));
  assert.equal(planned.state, "plan_refused");
  const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({
    where: { id: ideaId }, select: { state: true, analysisCompletedAt: true,
      currentSourcePlanRevisionId: true } });
  assert.equal(idea.state, "awaiting_owner");
  assert.ok(idea.analysisCompletedAt);
  assert.equal(idea.currentSourcePlanRevisionId, null);
  assert.equal(await prisma.amuxIdeaAnalysisChunk.count({ where: { ideaId } }), 0);
});

test("the receipt DB guard requires session scope evidence and no waiting refusal", async () => {
  assert.ok(registeredSystemIdeaId);
  assert.ok(registeredSystemIdeaPreviewId);
  assert.equal(registeredSystemIdeaUnitIds.length, 4);
  const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: {
    id: registeredSystemIdeaId,
  } });
  assert.ok(idea.systemRegistrationAuditLogId);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: {
    id: idea.systemRegistrationAuditLogId,
  } });
  assert.ok(idea.currentSourcePlanRevisionId);
  assert.ok(audit.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata));
  const receiptMetadata = { ...audit.metadata } as Record<string, unknown>;
  delete receiptMetadata.systemActor;
  delete receiptMetadata.actorScope;
  const writeReceiptAudit = (tx: Prisma.TransactionClient) =>
    writeSystemAuditLog({ tx, systemActor: "amux-v4-intake",
      action: AMUX_V19_SYSTEM_REGISTRATION_ACTION,
      targetType: AMUX_V19_SYSTEM_REGISTRATION_TARGET,
      targetId: registeredSystemIdeaId,
      summary: "Registered one completed AMUX intake plan into inert backlog.",
      metadata: receiptMetadata as Prisma.InputJsonObject });

  await assert.rejects(prisma.$transaction(async (tx) => {
    const ownerIdeaId = randomUUID();
    const submittedAt = new Date();
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.amuxIdeaSubmission.create({ data: { id: ownerIdeaId,
      requestId: randomUUID(), actorUserId: authority.approvedByUserId,
      submissionOrigin: "owner", state: "awaiting_owner", submittedAt,
      analysisDeadlineAt: new Date(submittedAt.getTime() + 7 * 86_400_000),
      analysisCompletedAt: submittedAt } });
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
    const auditId = await writeReceiptAudit(tx);
    await tx.amuxIdeaSubmission.update({ where: { id: ownerIdeaId },
      data: { state: "completed", systemRegistrationAuditLogId: auditId } });
  }), /AmuxIdeaSubmission_system_registration_transition_check|transition invalid/);

  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.amuxIdeaSubmission.update({ where: { id: registeredSystemIdeaId },
      data: { state: "awaiting_owner", systemRegistrationAuditLogId: null } });
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
    const refusalId = randomUUID();
    const refusalRequestId = randomUUID();
    const attemptedAt = new Date();
    const refusalMetadata = { policyVersion: "20",
      state: "awaiting_operator", requestId: refusalRequestId,
      attemptKind: "whole_plan", refusalCode: "plan_schema_invalid",
      ideaId: registeredSystemIdeaId,
      draftUnitId: registeredSystemIdeaUnitIds[3]!,
      analysisPreviewId: registeredSystemIdeaPreviewId,
      sourcePlanRevisionId: idea.currentSourcePlanRevisionId,
      proposedExecutionGrade: null, finalExecutionGrade: null,
      attemptedAt: attemptedAt.toISOString() };
    const refusalAuditId = await writeSystemAuditLog({ tx,
      systemActor: "amux-v4-intake",
      action: AMUX_V20_REGISTRATION_REFUSAL_ACTION,
      targetType: AMUX_V20_REGISTRATION_REFUSAL_TARGET,
      targetId: refusalId, summary: AMUX_V20_REGISTRATION_REFUSAL_SUMMARY,
      metadata: refusalMetadata });
    await tx.amuxIdeaRegistrationRefusal.create({ data: {
      id: refusalId, requestId: refusalRequestId, attemptKind: "whole_plan",
      state: "awaiting_operator", refusalCode: "plan_schema_invalid",
      ideaId: registeredSystemIdeaId,
      draftUnitId: registeredSystemIdeaUnitIds[3]!,
      actorUserId: authority.approvedByUserId,
      analysisPreviewId: registeredSystemIdeaPreviewId,
      sourcePlanRevisionId: idea.currentSourcePlanRevisionId!,
      proposedExecutionGrade: null, finalExecutionGrade: null,
      attemptedAt, auditLogId: refusalAuditId,
    } });
    const receiptAuditId = await writeReceiptAudit(tx);
    await tx.amuxIdeaSubmission.update({ where: { id: registeredSystemIdeaId },
      data: { state: "completed",
        systemRegistrationAuditLogId: receiptAuditId } });
  }), /AmuxIdeaSubmission_system_registration_evidence_check|evidence mismatch/);

  assert.deepEqual(await readAmuxV19SystemRegistration(registeredSystemIdeaId), {
    state: "committed", retryWrite: false, ideaId: registeredSystemIdeaId,
    auditId: idea.systemRegistrationAuditLogId,
  });
});

test("a mixed-path plan writes one durable refusal and no backlog rows", async () => {
  const { ideaId, unitIds } = await completedSessionIdea({ expectedPaths: [
    "lib/amux/ideaSystemRegistrationCore.ts",
    "components/admin/AmuxIdeaPlanApprovalPanel.tsx",
  ] });
  const before = await Promise.all([
    prisma.amuxIdeaUnitDecision.count(),
    prisma.amuxPortfolioNode.count(),
    prisma.amuxWorkItem.count(),
    prisma.amuxPortfolioAssessment.count(),
    prisma.amuxPortfolioScoreSnapshot.count(),
  ]);

  const first = await commitAmuxV19CompletedIdeaSystemRegistrationForTest(ideaId);
  assert.equal(first.state, "awaiting_operator");
  if (first.state !== "awaiting_operator") {
    throw new Error("mixed plan was not refused");
  }
  assert.deepEqual({ code: first.refusal.refusalCode,
    attemptKind: first.refusal.attemptKind,
    proposed: first.refusal.proposedExecutionGrade,
    final: first.refusal.finalExecutionGrade,
  }, { code: "task_expected_paths_mixed", attemptKind: "whole_plan",
    proposed: "advanced", final: null });

  const laterOwnerRefusal = await recordAmuxV20RegistrationRefusal({
    session, request, requestId: randomUUID(), attemptKind: "prepare",
    refusalCode: "task_role_review_refused", ideaId,
    draftUnitId: unitIds[3]!,
    analysisPreviewId: first.refusal.analysisPreviewId,
    proposedExecutionGrade: "advanced", finalExecutionGrade: null,
  });
  assert.equal(laterOwnerRefusal.attemptKind, "prepare");

  const digestKeyId = process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID;
  const digestKey = process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64;
  process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID =
    "synthetic-system-registration-rotated-digest";
  process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = randomBytes(32).toString("base64");
  let second;
  try {
    second = await commitAmuxV19CompletedIdeaSystemRegistrationForTest(ideaId);
  } finally {
    process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = digestKeyId;
    process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = digestKey;
  }
  assert.deepEqual(second, first);
  const after = await Promise.all([
    prisma.amuxIdeaUnitDecision.count(),
    prisma.amuxPortfolioNode.count(),
    prisma.amuxWorkItem.count(),
    prisma.amuxPortfolioAssessment.count(),
    prisma.amuxPortfolioScoreSnapshot.count(),
  ]);
  assert.deepEqual(after, before);
  assert.equal(await prisma.amuxWorkItem.count({ where: {
    sourceSystem: "admin-idea-v4", sourceKey: { in: unitIds },
  } }), 0);

  const rows = await prisma.amuxIdeaRegistrationRefusal.findMany({
    where: { ideaId, attemptKind: "whole_plan" }, include: { auditLog: true },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "awaiting_operator");
  assert.equal(rows[0]!.requestId, first.refusal.requestId);
  assert.equal(auditRowActorKind(rows[0]!.auditLog), "system");
  const evidence = JSON.stringify({ row: rows[0],
    auditMetadata: rows[0]!.auditLog.metadata });
  assert.equal(evidence.includes("components/admin"), false);
  assert.equal(evidence.includes("lib/amux"), false);
});

test("an unresolved duplicate writes one plan refusal and no backlog rows", async () => {
  assert.ok(registeredTaskTitle);
  const { ideaId, unitIds } = await completedSessionIdea({
    taskTitle: registeredTaskTitle,
  });
  const before = await Promise.all([
    prisma.amuxIdeaUnitDecision.count(),
    prisma.amuxPortfolioNode.count(),
    prisma.amuxWorkItem.count(),
  ]);
  const result = await commitAmuxV19CompletedIdeaSystemRegistrationForTest(ideaId);
  assert.equal(result.state, "awaiting_operator");
  if (result.state !== "awaiting_operator") {
    throw new Error("unresolved duplicate was not refused");
  }
  assert.equal(result.refusal.refusalCode, "plan_duplicate_unresolved");
  assert.deepEqual(await Promise.all([
    prisma.amuxIdeaUnitDecision.count(),
    prisma.amuxPortfolioNode.count(),
    prisma.amuxWorkItem.count(),
  ]), before);
  assert.equal(await prisma.amuxWorkItem.count({ where: {
    sourceSystem: "admin-idea-v4", sourceKey: { in: unitIds },
  } }), 0);
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({ where: {
    ideaId, refusalCode: "plan_duplicate_unresolved",
  } }), 1);
});

test("a system hierarchy refusal is durable before any backlog write", async () => {
  const { ideaId, previewId, unitIds } = await completedSessionIdea();
  const result = await recordAmuxV20RegistrationRefusal({
    systemActor: "amux-v4-intake", actorUserId: authority.approvedByUserId,
    requestId: randomUUID(), attemptKind: "whole_plan",
    refusalCode: "plan_hierarchy_invalid", ideaId,
    draftUnitId: unitIds[3]!, analysisPreviewId: previewId,
    proposedExecutionGrade: null, finalExecutionGrade: null,
  });
  assert.equal(result.state, "awaiting_operator");
  assert.equal(result.refusalCode, "plan_hierarchy_invalid");
  assert.equal(result.attemptKind, "whole_plan");
  assert.equal(await prisma.amuxWorkItem.count({ where: {
    sourceSystem: "admin-idea-v4", sourceKey: { in: unitIds },
  } }), 0);
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({ where: {
    ideaId, refusalCode: "plan_hierarchy_invalid",
  } }), 1);
});

test("a key-store failure writes neither a refusal nor backlog rows", async () => {
  const { ideaId, objectKeys } = await completedSessionIdea();
  assert.ok(objectKeys.length > 0, "the fixture did not create key objects");
  for (const key of objectKeys) objects.delete(key);
  await assert.rejects(commitAmuxV19CompletedIdeaSystemRegistrationForTest(ideaId),
    (error: unknown) => error instanceof AmuxIdeaUnitProposalReadError &&
      error.code === "integrity_unavailable");
  assert.equal(await prisma.amuxIdeaRegistrationRefusal.count({ where: {
    ideaId,
  } }), 0);
  assert.equal(await prisma.amuxIdeaUnitDecision.count({ where: { ideaId } }), 0);
});

test("the deferred DB guard rejects a forged system actor scope", async () => {
  assert.ok(registeredSystemDecisionId);
  assert.ok(registeredSystemDecisionAuditId);
  await assert.rejects(prisma.$transaction(async (tx) => {
    // This isolated-superuser mutation simulates storage corruption without
    // weakening the product writer. The enclosing transaction always rolls it
    // back after the real deferred trigger makes its decision.
    await tx.$executeRawUnsafe(
      "SET LOCAL session_replication_role = replica",
    );
    await tx.$executeRaw`
      UPDATE "AdminAuditLog"
      SET "metadata" = jsonb_set("metadata", '{actorScope}', '"forged"'::jsonb)
      WHERE "id" = ${registeredSystemDecisionAuditId}
    `;
    await tx.$executeRawUnsafe(
      "SET LOCAL session_replication_role = origin",
    );
    await tx.$executeRawUnsafe(`
      CREATE TEMP TABLE "AmuxIdeaUnitDecision" (
        "id" TEXT NOT NULL,
        "state" TEXT NOT NULL
      ) ON COMMIT DROP
    `);
    await tx.$executeRawUnsafe(`
      CREATE CONSTRAINT TRIGGER forged_system_registration_audit
      AFTER INSERT ON pg_temp."AmuxIdeaUnitDecision"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.amux_v4_registration_consistency_guard()
    `);
    await tx.$executeRaw`
      INSERT INTO pg_temp."AmuxIdeaUnitDecision" ("id", "state")
      VALUES (${registeredSystemDecisionId}, 'consumed')
    `;
    await tx.$executeRawUnsafe(
      "SET CONSTRAINTS forged_system_registration_audit IMMEDIATE",
    );
  }), /AMUX v4 registration draft or audit is incomplete/);

  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: {
    id: registeredSystemDecisionAuditId,
  } });
  assert.equal((audit.metadata as { actorScope?: string }).actorScope,
    "system-unit-registration-v1");
});
