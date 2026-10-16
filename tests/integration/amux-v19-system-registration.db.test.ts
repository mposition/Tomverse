import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { commitAmuxIdeaAnalysisBudgetReservation } from
  "@/lib/amux/ideaAnalysisBudgetReservationService";
import { commitAmuxIdeaOnlyAnalysisClaim } from
  "@/lib/amux/ideaAnalysisClaimService";
import { commitAmuxIdeaAnalysisResult } from
  "@/lib/amux/ideaAnalysisResultService";
import { commitAmuxIdeaAnalysisPriceApproval } from
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
import { createInitialIdeaOnlySourcePlan } from
  "@/lib/amux/ideaInitialSourcePlanService";
import { commitAmuxOperatingScope, readAmuxOperatingScopeAuthority,
  type AmuxOperatingScopeAuthority } from
  "@/lib/amux/ideaOperatingScopeStore";
import { inspectAmuxIdeaSessionSubmission } from
  "@/lib/amux/ideaSessionSubmissionCore";
import { commitAmuxIdeaSessionSubmission } from
  "@/lib/amux/ideaSessionSubmissionService";
import { commitAmuxV19CompletedIdeaSystemRegistration,
  readAmuxV19SystemRegistration } from
  "@/lib/amux/ideaSystemRegistrationService";
import { amuxAnalysisFreeformSubjectId } from
  "@/lib/amux/ideaAnalysisDraftSealCore";
import { commitIdeaOnlyTransferPreview } from
  "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation } from
  "@/lib/amux/ideaTransferConfirmationService";
import { prisma } from "@/lib/prisma";

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
} = {}) {
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
  const choice = { previewId, ideaId,
    provider: authority.scope.model.provider,
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
      status: true, expiresAt: true },
  });
  let priceVersionId = currentPrice?.status === "approved" &&
    currentPrice.expiresAt > new Date() ? currentPrice.id : null;
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
      title: `Synthetic Task ${ideaId}`, problem: "Register one bounded plan.",
      scopeIn: ["Register this fixture"], scopeOut: ["Do not execute it"],
      completionCriteria: ["The inert Task is auditable"], featureRef: "c0:node-2",
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
  return { ideaId, unitIds };
}

test("one completed session plan registers atomically under system evidence", async () => {
  await approveSyntheticTaskCatalog();
  const { ideaId, unitIds } = await completedSessionIdea();
  const before = {
    decisions: await prisma.amuxIdeaUnitDecision.count({ where: { ideaId } }),
    cards: await prisma.amuxWorkItem.count({ where: {
      sourceSystem: "admin-idea-v4", sourceKey: { in: unitIds } } }),
  };
  assert.deepEqual(before, { decisions: 0, cards: 0 });
  const result = await commitAmuxV19CompletedIdeaSystemRegistration(ideaId);
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
  assert.equal(JSON.stringify(audit.metadata).includes("lib/amux"), false);
  assert.deepEqual(await readAmuxV19SystemRegistration(ideaId), {
    state: "committed", retryWrite: false, ideaId, auditId: result.auditId,
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

  const first = await commitAmuxV19CompletedIdeaSystemRegistration(ideaId);
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

  const second = await commitAmuxV19CompletedIdeaSystemRegistration(ideaId);
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
    where: { ideaId }, include: { auditLog: true },
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
