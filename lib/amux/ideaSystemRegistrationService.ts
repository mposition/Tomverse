import "server-only";

import { amuxV22TaskWritesPatch } from "./v22WorkerClaimCore.ts";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V19_PORTFOLIO_ASSESSMENT_SCOPE,
  AMUX_V19_PORTFOLIO_SCORE_SCOPE,
  auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { loadAmuxCardDuplicateScanner } from
  "./ideaCardDuplicateScanService.ts";
import { orderAmuxV4CardPlan } from "./ideaCardPlanCore.ts";
import { AmuxV4CardPlanError } from "./ideaCardPlanCore.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { createAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { loadAmuxNodeDuplicateScanner } from
  "./ideaNodeDuplicateScanService.ts";
import { orderAmuxV4NodePlan } from "./ideaNodePlanCore.ts";
import { AmuxV4NodePlanError } from "./ideaNodePlanCore.ts";
import { prepareAmuxV4NodeCreationInTx } from
  "./ideaNodeRegistrationService.ts";
import { amuxV4PlanMetrics } from "./ideaPlanScreenCore.ts";
import { prepareAmuxV4CardRegistrationInTx } from
  "./ideaStoryRegistrationService.ts";
import { deriveAmuxIdeaUnitConfirmation,
  sameAmuxIdeaUnitConfirmation } from "./ideaUnitConfirmationCore.ts";
import { commitAmuxV4CardRegistration, commitAmuxV4NodeCreation,
  AmuxV4DuplicateReasonRequired } from
  "./ideaUnitDecisionStore.ts";
import { inspectAmuxV20TaskRegistration } from
  "./ideaUnitRegistrationCore.ts";
import { readVerifiedAmuxCardProposalForDataOwner,
  readVerifiedAmuxNodeProposalForDataOwner,
  AmuxIdeaUnitProposalReadError } from
  "./ideaUnitProposalReadService.ts";
import { findOpenAmuxOrchestratorHalt } from "./orchestratorHaltStore.ts";
import { AmuxPortfolioError, writeAmuxPortfolioAssessmentInTx } from
  "./portfolioAssessmentService.ts";
import { writeAmuxPortfolioScoreInTx } from "./portfolioScoreService.ts";
import { AMUX_IDEA_PLAN_APPROVAL_TRANSACTION } from
  "./ideaRequestTimeoutsCore.ts";
import { calculateCurrentApprovedAmuxV4TaskCost,
  readAmuxV4TaskAutoCatalog } from "./v4TaskCostCatalogApprovalService.ts";
import { calculateV4TaskCeilingFromCatalog } from "./v4TaskCostCatalogCore.ts";
import { AmuxV19PlanRegistrationRefusalDetected,
  AmuxV20RegistrationRefusalDetected } from
  "./ideaRegistrationRefusalDetectionCore.ts";
import { recordAmuxV20RegistrationRefusal } from
  "./ideaRegistrationRefusalService.ts";
import { readLatestAmuxV20RegistrationRefusalInTx } from
  "./ideaRegistrationRefusalReadService.ts";
import { AMUX_V19_SYSTEM_REGISTRATION_ACTION,
  AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR,
  AMUX_V19_SYSTEM_REGISTRATION_SCOPE,
  AMUX_V19_SYSTEM_REGISTRATION_TARGET,
  AMUX_V19_UNIT_REGISTRATION_AUTHORITY,
  amuxV19SystemRegistrationEnabled,
  amuxV19SystemRegistrationTestBoundary,
  deriveAmuxV19RegistrationRefusalRequestId,
  deriveAmuxV19SystemRegistrationBinding } from
  "./ideaSystemRegistrationCore.ts";

const IDEA_ID = /^[A-Za-z0-9:_-]{8,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class AmuxV19SystemRegistrationError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "write_disabled" |
    "halted" | "reconfirm" | "integrity_unavailable" | "outcome_unknown") {
    super(code);
    this.name = "AmuxV19SystemRegistrationError";
  }
}

type PreparedNode = {
  draftUnitId: string;
  localRef: string;
  level: "initiative" | "epic" | "feature";
  parentRef: string | null;
  verified: Awaited<ReturnType<
    typeof readVerifiedAmuxNodeProposalForDataOwner>>;
  decisionId: string;
  nodeId: string;
};

type PreparedCard = {
  draftUnitId: string;
  localRef: string;
  cardType: "story" | "task";
  parentStoryRef: string | null;
  dependencyRefs: readonly string[];
  verified: Awaited<ReturnType<
    typeof readVerifiedAmuxCardProposalForDataOwner>>;
  decisionId: string;
  cardId: string;
  featureNodeId: string;
};

type PreparedPlan = {
  ideaId: string;
  actorUserId: string;
  sourcePlanRevisionId: string;
  operatingScopeSettingId: string;
  operatingScopeApprovalAuditLogId: string;
  nodes: Array<PreparedNode & { parent: { kind: "none" } |
    { kind: "existing"; nodeId: string } |
    { kind: "batch"; localRef: string } }>;
  cards: PreparedCard[];
  nodeIdOf: Map<string, string>;
  keys: ReturnType<typeof loadCurrentAmuxContentKeys>;
  nodeScanner: Awaited<ReturnType<typeof loadAmuxNodeDuplicateScanner>> | null;
  cardScanner: Awaited<ReturnType<typeof loadAmuxCardDuplicateScanner>> | null;
  evidenceAsOf: string;
};

async function prepareCompletedPlan(ideaId: string): Promise<PreparedPlan> {
  if (!IDEA_ID.test(ideaId)) {
    throw new AmuxV19SystemRegistrationError("not_found");
  }
  const idea = await prisma.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { id: true, actorUserId: true, submissionOrigin: true, state: true,
      analysisCompletedAt: true, currentSourcePlanRevisionId: true,
      sessionOperatingScopeSettingId: true,
      systemRegistrationAuditLogId: true },
  });
  if (!idea || idea.submissionOrigin !== "session") {
    throw new AmuxV19SystemRegistrationError("not_found");
  }
  if (idea.systemRegistrationAuditLogId) {
    throw new AmuxV19SystemRegistrationError("reconfirm");
  }
  if (idea.state !== "awaiting_owner" || !idea.analysisCompletedAt ||
      !idea.currentSourcePlanRevisionId || !idea.sessionOperatingScopeSettingId) {
    throw new AmuxV19SystemRegistrationError("not_ready");
  }
  const operatingScope = await prisma.amuxIdeaOperatingScopeSetting.findFirst({
    where: { id: idea.sessionOperatingScopeSettingId,
      approvedByUserId: idea.actorUserId },
    select: { id: true, approvalAuditLogId: true },
  });
  if (!operatingScope) {
    throw new AmuxV19SystemRegistrationError("integrity_unavailable");
  }
  const units = await prisma.amuxIdeaDraftUnit.findMany({ where: {
    ideaId, actorUserId: idea.actorUserId, derivationGroupId: null,
    unitKind: { in: ["node", "card"] },
  }, select: { id: true, unitKind: true, state: true, chunkIndex: true },
  orderBy: [{ chunkIndex: "asc" }, { unitIndex: "asc" }] });
  if (units.length === 0 || units.some((unit) => unit.state !== "proposed")) {
    throw new AmuxV19SystemRegistrationError("not_ready");
  }
  const chunks = await prisma.amuxIdeaAnalysisChunk.findMany({ where: {
    ideaId, chunkIndex: { in: [...new Set(units.map((unit) => unit.chunkIndex))] },
  }, select: { chunkIndex: true, currentPreviewId: true,
    sourcePlanRevisionId: true } });
  const previewByChunk = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk]));
  const refusalIdentity = (unit: (typeof units)[number]) => {
    const chunk = previewByChunk.get(unit.chunkIndex);
    if (!chunk?.currentPreviewId ||
        chunk.sourcePlanRevisionId !== idea.currentSourcePlanRevisionId) {
      throw new AmuxV19SystemRegistrationError("integrity_unavailable");
    }
    return { ideaId, draftUnitId: unit.id,
      analysisPreviewId: chunk.currentPreviewId };
  };
  const verifiedNodes: Array<Awaited<ReturnType<
    typeof readVerifiedAmuxNodeProposalForDataOwner>>> = [];
  for (const unit of units.filter((entry) => entry.unitKind === "node")) {
    try {
      verifiedNodes.push(await readVerifiedAmuxNodeProposalForDataOwner(
        idea.actorUserId, ideaId, unit.id));
    } catch (error) {
      if (!(error instanceof AmuxIdeaUnitProposalReadError) ||
          error.code !== "schema_invalid") throw error;
      throw new AmuxV19PlanRegistrationRefusalDetected(
        "plan_schema_invalid", refusalIdentity(unit));
    }
  }
  const verifiedCards: Array<Awaited<ReturnType<
    typeof readVerifiedAmuxCardProposalForDataOwner>>> = [];
  for (const unit of units.filter((entry) => entry.unitKind === "card")) {
    try {
      verifiedCards.push(await readVerifiedAmuxCardProposalForDataOwner(
        idea.actorUserId, ideaId, unit.id));
    } catch (error) {
      if (!(error instanceof AmuxIdeaUnitProposalReadError) ||
          error.code !== "schema_invalid") throw error;
      throw new AmuxV19PlanRegistrationRefusalDetected(
        "plan_schema_invalid", refusalIdentity(unit));
    }
  }
  const externalParentRefs = [...new Set(verifiedNodes.map((entry) =>
    entry.proposal.parentRef).filter((value): value is string =>
    value !== null && UUID.test(value)))];
  const externalParents = externalParentRefs.length === 0 ? [] :
    await prisma.amuxPortfolioNode.findMany({ where: {
      id: { in: externalParentRefs }, state: "active",
    }, select: { id: true, level: true } });
  const externalLevel = new Map(externalParents.map((node) =>
    [node.id, node.level]));
  const existing = new Map<string, string>();
  for (const entry of verifiedNodes) {
    const ref = entry.proposal.parentRef;
    if (!ref || !UUID.test(ref)) continue;
    const requiredLevel = entry.proposal.level === "epic" ? "initiative" :
      entry.proposal.level === "feature" ? "epic" : null;
    if (requiredLevel && externalLevel.get(ref) === requiredLevel) {
      existing.set(ref, ref);
    }
  }
  let nodes: PreparedPlan["nodes"];
  try {
    nodes = orderAmuxV4NodePlan<PreparedNode>(verifiedNodes.map((verified) => ({
      draftUnitId: verified.unit.id, localRef: verified.unit.localRef,
      level: verified.proposal.level, parentRef: verified.proposal.parentRef,
      verified, decisionId: randomUUID(), nodeId: randomUUID(),
    })), existing);
  } catch (error) {
    if (!(error instanceof AmuxV4NodePlanError) ||
        error.code !== "parent_unresolved" || !error.draftUnitIds[0]) throw error;
    const unit = units.find((entry) => entry.id === error.draftUnitIds[0]);
    if (!unit) throw new AmuxV19SystemRegistrationError("integrity_unavailable");
    throw new AmuxV19PlanRegistrationRefusalDetected(
      "plan_hierarchy_invalid", refusalIdentity(unit));
  }
  const nodeIdOf = new Map(nodes.map((entry) => [entry.localRef, entry.nodeId]));
  const featureIdOf = new Map(nodes.filter((entry) => entry.level === "feature")
    .map((entry) => [entry.localRef, entry.nodeId]));
  const externalFeatureRefs = [...new Set(verifiedCards.map((entry) =>
    entry.proposal.featureRef).filter((value) => UUID.test(value)))];
  const externalFeatures = externalFeatureRefs.length === 0 ? [] :
    await prisma.amuxPortfolioNode.findMany({ where: {
      id: { in: externalFeatureRefs }, state: "active", level: "feature",
    }, select: { id: true } });
  const externalFeatureIds = new Set(externalFeatures.map((entry) => entry.id));
  const unresolved = verifiedCards.filter((entry) =>
    !featureIdOf.has(entry.proposal.featureRef) &&
    !externalFeatureIds.has(entry.proposal.featureRef));
  if (unresolved.length > 0) {
    const unit = units.find((entry) => entry.id === unresolved[0]!.unit.id)!;
    throw new AmuxV19PlanRegistrationRefusalDetected(
      "plan_hierarchy_invalid", refusalIdentity(unit));
  }
  let cards: PreparedCard[];
  try {
    cards = orderAmuxV4CardPlan<PreparedCard>(verifiedCards.map((verified) => ({
      draftUnitId: verified.unit.id, localRef: verified.unit.localRef,
      cardType: verified.proposal.cardType,
      parentStoryRef: verified.proposal.parentStoryRef,
      dependencyRefs: verified.proposal.dependencyRefs,
      verified, decisionId: randomUUID(), cardId: randomUUID(),
      featureNodeId: featureIdOf.get(verified.proposal.featureRef) ??
        verified.proposal.featureRef,
    })));
  } catch (error) {
    // orderAmuxV4CardPlan emits only dependency_cycle. Parent Story and
    // dependency reference validity are checked immediately below and mapped
    // to the corresponding durable whole-plan refusal.
    if (!(error instanceof AmuxV4CardPlanError) ||
        error.code !== "dependency_cycle" || !error.draftUnitIds[0]) throw error;
    const unit = units.find((entry) => entry.id === error.draftUnitIds[0]);
    if (!unit) throw new AmuxV19SystemRegistrationError("integrity_unavailable");
    throw new AmuxV19PlanRegistrationRefusalDetected(
      "plan_dependency_cycle", refusalIdentity(unit));
  }
  const cardKindByRef = new Map(cards.map((entry) =>
    [entry.localRef, entry.cardType]));
  const externalCardRefs = [...new Set(cards.flatMap((entry) => [
    ...(entry.parentStoryRef && UUID.test(entry.parentStoryRef) ?
      [entry.parentStoryRef] : []),
    ...entry.dependencyRefs.filter((ref) => UUID.test(ref)),
  ]))];
  const externalCards = externalCardRefs.length === 0 ? [] :
    await prisma.amuxWorkItem.findMany({ where: { id: { in: externalCardRefs },
      sourceSystem: "admin-idea-v4", archivedAt: null,
      status: { in: ["backlog", "todo", "doing", "review", "done", "blocked"] },
    }, select: { id: true, cardType: true, status: true,
      parentFeatureNodeId: true } });
  const externalCardById = new Map(externalCards.map((entry) =>
    [entry.id, entry]));
  for (const entry of cards) {
    const parent = entry.parentStoryRef;
    const parentValid = parent === null ||
      (UUID.test(parent) ? (() => {
        const card = externalCardById.get(parent);
        return card?.cardType === "story" && card.status === "backlog" &&
          card.parentFeatureNodeId === entry.featureNodeId;
      })() : cardKindByRef.get(parent) === "story");
    if (!parentValid) {
      const unit = units.find((candidate) => candidate.id === entry.draftUnitId)!;
      throw new AmuxV19PlanRegistrationRefusalDetected(
        "plan_hierarchy_invalid", refusalIdentity(unit));
    }
    const dependenciesValid = entry.dependencyRefs.every((ref) =>
      UUID.test(ref) ? externalCardById.get(ref)?.cardType === "task" :
        cardKindByRef.get(ref) === "task") &&
      !entry.dependencyRefs.includes(entry.localRef);
    if (!dependenciesValid) {
      const unit = units.find((candidate) => candidate.id === entry.draftUnitId)!;
      throw new AmuxV19PlanRegistrationRefusalDetected(
        "plan_dependency_invalid", refusalIdentity(unit));
    }
  }
  // Read once for every Task of the plan, and only when a Task reaches it.
  let catalog: Awaited<ReturnType<typeof readAmuxV4TaskAutoCatalog>> | undefined;
  for (const card of cards) {
    if (card.cardType !== "task") continue;
    const identity = { ideaId, draftUnitId: card.draftUnitId,
      analysisPreviewId: card.verified.previewId };
    const inspected = inspectAmuxV20TaskRegistration(card.verified.proposal);
    if (!inspected.ok) {
      throw new AmuxV20RegistrationRefusalDetected(inspected.code, identity,
        card.verified.proposal);
    }
    // No priced worker for the role and grade -- including no priced worker
    // at all (no_priced_worker) -- is a recorded refusal here, not an unknown
    // outcome of the registration transaction below. A registry or catalog
    // that cannot be read throws from the read: that is no refusal of a Task.
    catalog ??= await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      return readAmuxV4TaskAutoCatalog(tx);
    });
    const priced = catalog.ok && calculateV4TaskCeilingFromCatalog({
      rawCatalog: catalog.catalog, role: card.verified.proposal.taskRole!,
      grade: inspected.executionGrade, asOfIso: new Date().toISOString() }).ok;
    if (!priced) {
      throw new AmuxV20RegistrationRefusalDetected("task_route_unpriced",
        identity, card.verified.proposal);
    }
  }
  const every = [...nodes, ...cards];
  for (const entry of every) {
    const proposal = entry.verified.proposal;
    const kind = proposal.kind === "node" ? proposal.level : proposal.cardType;
    if (!proposal.portfolioSignal ||
        !amuxV4PlanMetrics(kind, proposal.portfolioSignal.metrics)) {
      const unit = units.find((candidate) => candidate.id === entry.draftUnitId)!;
      throw new AmuxV19PlanRegistrationRefusalDetected(
        "plan_score_invalid", refusalIdentity(unit));
    }
  }
  const keys = loadCurrentAmuxContentKeys(process.env);
  return { ideaId, actorUserId: idea.actorUserId,
    sourcePlanRevisionId: idea.currentSourcePlanRevisionId,
    operatingScopeSettingId: operatingScope.id,
    operatingScopeApprovalAuditLogId: operatingScope.approvalAuditLogId,
    nodes, cards, nodeIdOf, keys,
    nodeScanner: nodes.length ? await loadAmuxNodeDuplicateScanner() : null,
    cardScanner: cards.length ? await loadAmuxCardDuplicateScanner() : null,
    evidenceAsOf: new Date(Date.now() - 1_000).toISOString() };
}

const parentNodeId = (plan: PreparedPlan,
  entry: PreparedPlan["nodes"][number]) => entry.parent.kind === "none" ? null :
  entry.parent.kind === "existing" ? entry.parent.nodeId :
    plan.nodeIdOf.get(entry.parent.localRef)!;

type SystemRegistrationRefusal = AmuxV20RegistrationRefusalDetected |
  AmuxV19PlanRegistrationRefusalDetected;

const isSystemRegistrationRefusal = (
  error: unknown,
): error is SystemRegistrationRefusal =>
  error instanceof AmuxV20RegistrationRefusalDetected ||
  error instanceof AmuxV19PlanRegistrationRefusalDetected;

const isSystemPortfolioAudit = (audit: {
  action: string; targetType: string; targetId: string | null;
  actorUserId: string | null; actorEmail: string | null;
  ipAddress: string | null; userAgent: string | null;
  metadata: Prisma.JsonValue; entryHash: string | null;
}, expected: { action: string; targetType: string; targetId: string;
  actorScope: string }): boolean => {
  const metadata = audit.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata) ?
    audit.metadata as Record<string, unknown> : null;
  return !!audit.entryHash && auditRowActorKind(audit) === "system" &&
    audit.action === expected.action && audit.targetType === expected.targetType &&
    audit.targetId === expected.targetId &&
    metadata?.systemActor === AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR &&
    metadata.actorScope === expected.actorScope;
};

async function readExistingSystemRegistrationRefusal(ideaId: string) {
  if (!IDEA_ID.test(ideaId)) return null;
  const idea = await prisma.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { actorUserId: true, state: true, currentSourcePlanRevisionId: true,
      systemRegistrationAuditLogId: true },
  });
  if (!idea || idea.state !== "awaiting_owner" ||
      !idea.currentSourcePlanRevisionId || idea.systemRegistrationAuditLogId) {
    return null;
  }
  const candidate = await prisma.amuxIdeaRegistrationRefusal.findFirst({ where: {
    ideaId, actorUserId: idea.actorUserId, state: "awaiting_operator",
    attemptKind: "whole_plan",
    sourcePlanRevisionId: idea.currentSourcePlanRevisionId,
  }, orderBy: [{ attemptedAt: "desc" }, { id: "desc" }],
  select: { analysisPreviewId: true } });
  if (!candidate) return null;
  return prisma.$transaction((tx) => readLatestAmuxV20RegistrationRefusalInTx(
    tx, ideaId, idea.actorUserId, candidate.analysisPreviewId,
    idea.currentSourcePlanRevisionId!, { attemptKind: "whole_plan" },
  ));
}

async function assertSystemRegistrationReadyInTx(
  tx: Prisma.TransactionClient,
  plan: PreparedPlan,
) {
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string; state: string;
    actorUserId: string; currentSourcePlanRevisionId: string | null;
    sessionOperatingScopeSettingId: string | null;
    systemRegistrationAuditLogId: string | null }>>`
    SELECT "id", "state", "actorUserId", "currentSourcePlanRevisionId",
           "sessionOperatingScopeSettingId", "systemRegistrationAuditLogId"
    FROM "AmuxIdeaSubmission" WHERE "id" = ${plan.ideaId} FOR UPDATE
  `;
  const idea = locked[0];
  if (locked.length !== 1 || !idea || idea.state !== "awaiting_owner" ||
      idea.actorUserId !== plan.actorUserId ||
      idea.currentSourcePlanRevisionId !== plan.sourcePlanRevisionId ||
      idea.sessionOperatingScopeSettingId !== plan.operatingScopeSettingId ||
      idea.systemRegistrationAuditLogId !== null) {
    throw new AmuxV19SystemRegistrationError("reconfirm");
  }
  if (await findOpenAmuxOrchestratorHalt(tx)) {
    throw new AmuxV19SystemRegistrationError("halted");
  }
  const operatingScope = await tx.amuxIdeaOperatingScopeSetting.findFirst({
    where: { id: plan.operatingScopeSettingId,
      approvedByUserId: plan.actorUserId,
      approvalAuditLogId: plan.operatingScopeApprovalAuditLogId },
    select: { id: true },
  });
  if (!operatingScope) {
    throw new AmuxV19SystemRegistrationError("integrity_unavailable");
  }
  if (await tx.amuxIdeaUnitDecision.count({ where: {
    ideaId: plan.ideaId,
  } }) !== 0) {
    throw new AmuxV19SystemRegistrationError("reconfirm");
  }
  const pendingRefusal = await tx.amuxIdeaRegistrationRefusal.findFirst({
    where: { ideaId: plan.ideaId, actorUserId: plan.actorUserId,
      state: "awaiting_operator", attemptKind: "whole_plan",
      sourcePlanRevisionId: plan.sourcePlanRevisionId },
    select: { id: true },
  });
  if (pendingRefusal) {
    throw new AmuxV19SystemRegistrationError("reconfirm");
  }
}

async function createSystemRegistrationContentKeys(plan: PreparedPlan) {
  const every = [...plan.nodes, ...plan.cards];
  return createAmuxContentKeyRing(
    every.map((entry) => ({ ideaId: plan.ideaId,
      purpose: "analysis_draft" as const, subjectId: entry.draftUnitId })),
    [...plan.nodes.map((entry) => ({ ideaId: plan.ideaId,
      purpose: "node_content" as const, subjectId: entry.nodeId })),
    ...plan.cards.flatMap((entry) => [
      { ideaId: plan.ideaId, purpose: "card_title" as const,
        subjectId: entry.cardId },
      { ideaId: plan.ideaId, purpose: "card_body" as const,
        subjectId: entry.cardId },
      ...(entry.cardType === "task" ? [{ ideaId: plan.ideaId,
        purpose: "card_brief" as const, subjectId: entry.cardId }] : []),
    ])]);
}

async function persistSystemRegistrationRefusal(
  error: SystemRegistrationRefusal,
) {
  const idea = await prisma.amuxIdeaSubmission.findUnique({ where: {
    id: error.identity.ideaId,
  }, select: { actorUserId: true, currentSourcePlanRevisionId: true,
    state: true, systemRegistrationAuditLogId: true } });
  if (!idea || idea.state !== "awaiting_owner" ||
      !idea.currentSourcePlanRevisionId || idea.systemRegistrationAuditLogId) {
    throw new AmuxV19SystemRegistrationError("integrity_unavailable");
  }
  const keys = loadCurrentAmuxContentKeys(process.env);
  const requestId = deriveAmuxV19RegistrationRefusalRequestId({
    ...error.identity, refusalCode: error.code, key: keys,
  });
  return recordAmuxV20RegistrationRefusal({
    systemActor: AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR,
    actorUserId: idea.actorUserId, requestId, attemptKind: "whole_plan",
    refusalCode: error.code, ...error.identity,
    proposedExecutionGrade: error.proposedExecutionGrade,
    finalExecutionGrade: error.finalExecutionGrade,
  });
}

/** No Session or owner step-up is accepted on this system-only boundary. */
async function commitAmuxV19CompletedIdeaSystemRegistration(
  ideaId: string,
) {
  const existingRefusal = await readExistingSystemRegistrationRefusal(ideaId);
  if (existingRefusal) {
    return { state: "awaiting_operator" as const, retryWrite: false as const,
      ideaId, refusal: existingRefusal };
  }
  let plan: PreparedPlan;
  try {
    plan = await prepareCompletedPlan(ideaId);
  } catch (error) {
    if (!isSystemRegistrationRefusal(error)) throw error;
    const refusal = await persistSystemRegistrationRefusal(error);
    return { state: "awaiting_operator" as const, retryWrite: false as const,
      ideaId, refusal };
  }
  const authority = { systemActor: AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR,
    actorUserId: plan.actorUserId } as const;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    await assertSystemRegistrationReadyInTx(tx, plan);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    ...AMUX_IDEA_PLAN_APPROVAL_TRANSACTION });
  const contentKeys = await createSystemRegistrationContentKeys(plan);
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await assertSystemRegistrationReadyInTx(tx, plan);
      const nodes = [];
      for (const entry of plan.nodes) {
        const parent = parentNodeId(plan, entry);
        const ownerSession = deriveAmuxV19SystemRegistrationBinding({
          ideaId: plan.ideaId, decisionId: entry.decisionId,
          actorUserId: plan.actorUserId, key: plan.keys,
        });
        let prepared;
        try {
          prepared = await prepareAmuxV4NodeCreationInTx(tx, {
            ...authority, registrationAuthority: AMUX_V19_UNIT_REGISTRATION_AUTHORITY,
            choice: { ideaId: plan.ideaId, draftUnitId: entry.draftUnitId,
              parentNodeId: parent, prepareRequestId: randomUUID(),
              decisionReason: null },
            verified: entry.verified, scanner: plan.nodeScanner!, keys: plan.keys,
            decisionId: entry.decisionId, nodeId: entry.nodeId, ownerSession,
          });
        } catch (error) {
          if (!(error instanceof AmuxV4DuplicateReasonRequired)) throw error;
          throw new AmuxV19PlanRegistrationRefusalDetected(
            "plan_duplicate_unresolved", { ideaId: plan.ideaId,
              draftUnitId: entry.draftUnitId,
              analysisPreviewId: entry.verified.previewId });
        }
        const current = deriveAmuxIdeaUnitConfirmation(prepared.snapshot,
          plan.keys, prepared.snapshot.duplicates, null);
        if (!current.ok || !sameAmuxIdeaUnitConfirmation(
          current.confirmationDigest, prepared.result.confirmationDigest)) {
          throw new AmuxV19SystemRegistrationError("reconfirm");
        }
        await commitAmuxV4NodeCreation(tx, { ...authority,
          snapshot: prepared.snapshot, proposal: entry.verified.proposal,
          consumeRequestId: randomUUID(), keys: contentKeys,
          recalculate: (transaction) => plan.nodeScanner!(transaction, {
            unitId: entry.draftUnitId, title: entry.verified.proposal.title,
            level: entry.verified.proposal.level, parentId: parent }),
          context: { decisionId: entry.decisionId, ideaId: plan.ideaId,
            draftUnitId: entry.draftUnitId, actorUserId: plan.actorUserId,
            registrationAuthority: "system", recentOwnerStepUp: false,
            ownerSessionDigest: ownerSession.digest,
            ownerSessionDigestKeyId: ownerSession.keyId },
        });
        await plan.nodeScanner!.admitCreated(tx, { id: entry.nodeId,
          title: entry.verified.proposal.title });
        nodes.push({ draftUnitId: entry.draftUnitId,
          decisionId: entry.decisionId, nodeId: entry.nodeId,
          level: entry.level });
      }
      const cards = [];
      for (const entry of plan.cards) {
        const proposal = entry.verified.proposal;
        // amux-intake.md v19 item 5 explicitly makes this default true for
        // unattended implement (and test) Tasks under the saved operating scope.
        const publicPrDisclosureApproved = entry.cardType === "task" &&
          amuxV22TaskWritesPatch(proposal.taskRole);
        const ownerSession = deriveAmuxV19SystemRegistrationBinding({
          ideaId: plan.ideaId, decisionId: entry.decisionId,
          actorUserId: plan.actorUserId, key: plan.keys,
        });
        let prepared;
        try {
          prepared = await prepareAmuxV4CardRegistrationInTx(tx, {
            ...authority, registrationAuthority: AMUX_V19_UNIT_REGISTRATION_AUTHORITY,
            choice: { ideaId: plan.ideaId, draftUnitId: entry.draftUnitId,
              featureNodeId: entry.featureNodeId, prepareRequestId: randomUUID(),
              decisionReason: null, cardType: entry.cardType,
              publicPrDisclosureApproved },
            verified: entry.verified, scanner: plan.cardScanner!, keys: plan.keys,
            decisionId: entry.decisionId, ownerSession,
          });
        } catch (error) {
          if (!(error instanceof AmuxV4DuplicateReasonRequired)) throw error;
          throw new AmuxV19PlanRegistrationRefusalDetected(
            "plan_duplicate_unresolved", { ideaId: plan.ideaId,
              draftUnitId: entry.draftUnitId,
              analysisPreviewId: entry.verified.previewId });
        }
        const current = deriveAmuxIdeaUnitConfirmation(prepared.snapshot,
          plan.keys, prepared.snapshot.duplicates,
          prepared.snapshot.card?.cardType === "task" ?
            { ok: true, receipt: prepared.snapshot.card.task!.costReceipt } : null);
        if (!current.ok || !sameAmuxIdeaUnitConfirmation(
          current.confirmationDigest, prepared.result.confirmationDigest)) {
          throw new AmuxV19SystemRegistrationError("reconfirm");
        }
        await commitAmuxV4CardRegistration(tx, { ...authority,
          snapshot: prepared.snapshot, proposal, cardId: entry.cardId,
          consumeRequestId: randomUUID(), keys: contentKeys,
          recalculate: async (transaction) => {
            let taskCost = null;
            if (proposal.cardType === "task") {
              const inspected = inspectAmuxV20TaskRegistration(proposal);
              if (!inspected.ok) {
                throw new AmuxV20RegistrationRefusalDetected(inspected.code, {
                  ideaId: plan.ideaId, draftUnitId: entry.draftUnitId,
                  analysisPreviewId: entry.verified.previewId,
                }, proposal);
              }
              const approved = await calculateCurrentApprovedAmuxV4TaskCost(
                transaction, proposal.taskRole!, inspected.executionGrade);
              taskCost = { ok: true as const, receipt: approved.receipt };
            }
            return { duplicateScan: await plan.cardScanner!(transaction, {
              unitId: entry.draftUnitId, proposal,
              featureNodeId: entry.featureNodeId }), taskCost };
          },
          context: { decisionId: entry.decisionId, ideaId: plan.ideaId,
            draftUnitId: entry.draftUnitId, actorUserId: plan.actorUserId,
            registrationAuthority: "system", recentOwnerStepUp: false,
            ownerSessionDigest: ownerSession.digest,
            ownerSessionDigestKeyId: ownerSession.keyId },
        });
        await plan.cardScanner!.admitCreated(tx, { id: entry.cardId,
          title: proposal.title });
        cards.push({ draftUnitId: entry.draftUnitId,
          decisionId: entry.decisionId, cardId: entry.cardId,
          cardType: entry.cardType, publicPrDisclosureApproved });
      }
      const subjectOf = new Map<string, { kind: "initiative" | "epic" |
        "feature" | "story" | "task"; id: string }>([
        ...plan.nodes.map((entry) => [entry.localRef,
          { kind: entry.level, id: entry.nodeId }] as const),
        ...plan.cards.map((entry) => [entry.localRef,
          { kind: entry.cardType, id: entry.cardId }] as const),
      ]);
      const assessments = [];
      for (const entry of [...plan.nodes, ...plan.cards]) {
        const proposal = entry.verified.proposal;
        const subject = subjectOf.get(entry.localRef)!;
        const signal = proposal.portfolioSignal!;
        const metrics = amuxV4PlanMetrics(subject.kind, signal.metrics);
        if (!metrics) throw new AmuxV19SystemRegistrationError("reconfirm");
        let written;
        try {
          written = await writeAmuxPortfolioAssessmentInTx(tx, {
            ...authority, digestKey: plan.keys, confirmationDigest: null,
            payload: { id: randomUUID(), requestId: randomUUID(), subject,
              metrics, uncertainty: signal.uncertainty,
              evidenceRefs: [`unit:${entry.draftUnitId}`],
              evidenceAsOf: plan.evidenceAsOf, reasonCode: "initial",
              modelProposalDigest: entry.verified.unit.bodyDigest },
          });
        } catch (error) {
          if (!(error instanceof AmuxPortfolioError) ||
              error.code !== "invalid_input") throw error;
          throw new AmuxV19PlanRegistrationRefusalDetected(
            "plan_score_invalid", { ideaId: plan.ideaId,
              draftUnitId: entry.draftUnitId,
              analysisPreviewId: entry.verified.previewId });
        }
        assessments.push({ subject, assessmentId: written.assessmentId });
      }
      const scores = [];
      for (const entry of plan.cards.filter((card) =>
        card.cardType === "task")) {
        let written;
        try {
          written = await writeAmuxPortfolioScoreInTx(tx, {
            ...authority, digestKey: plan.keys, confirmationDigest: null,
            payload: { id: randomUUID(), requestId: randomUUID(),
              taskId: entry.cardId },
          });
        } catch (error) {
          if (!(error instanceof AmuxPortfolioError) ||
              error.code !== "invalid_input") throw error;
          throw new AmuxV19PlanRegistrationRefusalDetected(
            "plan_score_invalid", { ideaId: plan.ideaId,
              draftUnitId: entry.draftUnitId,
              analysisPreviewId: entry.verified.previewId });
        }
        scores.push({ taskId: entry.cardId, scoreId: written.scoreId,
          total: written.score.total });
      }
      const auditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR,
        action: AMUX_V19_SYSTEM_REGISTRATION_ACTION,
        targetType: AMUX_V19_SYSTEM_REGISTRATION_TARGET,
        targetId: plan.ideaId,
        summary: "Registered one completed AMUX intake plan into inert backlog.",
        metadata: { ideaId: plan.ideaId,
          sourcePlanRevisionId: plan.sourcePlanRevisionId,
          operatingScopeSettingId: plan.operatingScopeSettingId,
          operatingScopeApprovalAuditLogId:
            plan.operatingScopeApprovalAuditLogId,
          nodeCount: nodes.length, cardCount: cards.length,
          assessmentCount: assessments.length, scoreCount: scores.length,
          publicPrConsentCount: cards.filter((card) =>
            card.publicPrDisclosureApproved).length,
          executionAttempted: false },
      });
      const completed = await tx.amuxIdeaSubmission.updateMany({ where: {
        id: plan.ideaId, actorUserId: plan.actorUserId,
        state: "awaiting_owner", currentSourcePlanRevisionId:
          plan.sourcePlanRevisionId, systemRegistrationAuditLogId: null,
      }, data: { state: "completed", systemRegistrationAuditLogId: auditId } });
      if (completed.count !== 1) {
        throw new AmuxV19SystemRegistrationError("reconfirm");
      }
      callbackReturned = true;
      return { state: "committed" as const, retryWrite: false as const,
        ideaId: plan.ideaId, auditId, nodes, cards, assessments, scores };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      ...AMUX_IDEA_PLAN_APPROVAL_TRANSACTION });
    return result;
  } catch (error) {
    if (!callbackReturned && isSystemRegistrationRefusal(error)) {
      const refusal = await persistSystemRegistrationRefusal(error);
      return { state: "awaiting_operator" as const,
        retryWrite: false as const, ideaId: plan.ideaId, refusal };
    }
    if (!callbackReturned) throw error;
    const readback = await readAmuxV19SystemRegistration(ideaId)
      .catch(() => ({ state: "inconsistent" as const,
        retryWrite: false as const }));
    if (readback.state === "committed") return readback;
    throw new AmuxV19SystemRegistrationError("outcome_unknown");
  }
}

/** Default-off public service. A later activation changes the code latch in
 * review; an environment value alone cannot open this write path. */
export async function registerCompletedAmuxIdeaFromSystem(ideaId: string) {
  if (!amuxV19SystemRegistrationEnabled(process.env)) {
    throw new AmuxV19SystemRegistrationError("write_disabled");
  }
  return commitAmuxV19CompletedIdeaSystemRegistration(ideaId);
}

/** Isolated synthetic DB entry point. This cannot run against a production DB. */
export async function commitAmuxV19CompletedIdeaSystemRegistrationForTest(
  ideaId: string,
) {
  if (!amuxV19SystemRegistrationTestBoundary(process.env)) {
    throw new AmuxV19SystemRegistrationError("write_disabled");
  }
  return commitAmuxV19CompletedIdeaSystemRegistration(ideaId);
}

/** Exact-idea readback after an unknown COMMIT outcome. It never retries. */
export async function readAmuxV19SystemRegistration(ideaId: string) {
  if (!IDEA_ID.test(ideaId)) {
    throw new AmuxV19SystemRegistrationError("not_found");
  }
  const idea = await prisma.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { id: true, state: true, currentSourcePlanRevisionId: true,
      actorUserId: true, sessionOperatingScopeSettingId: true,
      systemRegistrationAuditLogId: true },
  });
  if (!idea) throw new AmuxV19SystemRegistrationError("not_found");
  if (!idea.systemRegistrationAuditLogId) {
    return { state: idea.state === "completed" ? "inconsistent" as const :
      "not_visible" as const, retryWrite: false as const };
  }
  const audit = await prisma.adminAuditLog.findUnique({ where: {
    id: idea.systemRegistrationAuditLogId,
  } });
  if (idea.state !== "completed" || !audit?.entryHash ||
      audit.action !== AMUX_V19_SYSTEM_REGISTRATION_ACTION ||
      audit.targetType !== AMUX_V19_SYSTEM_REGISTRATION_TARGET ||
      audit.targetId !== idea.id || auditRowActorKind(audit) !== "system") {
    return { state: "inconsistent" as const, retryWrite: false as const };
  }
  const metadata = audit.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata) ?
    audit.metadata as Record<string, unknown> : null;
  if (!metadata || !idea.currentSourcePlanRevisionId ||
      !idea.sessionOperatingScopeSettingId ||
      metadata.systemActor !== AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR ||
      metadata.actorScope !== AMUX_V19_SYSTEM_REGISTRATION_SCOPE) {
    return { state: "inconsistent" as const, retryWrite: false as const };
  }
  const operatingScope = await prisma.amuxIdeaOperatingScopeSetting.findFirst({
    where: { id: idea.sessionOperatingScopeSettingId,
      approvedByUserId: idea.actorUserId },
    select: { approvalAuditLogId: true },
  });
  if (!operatingScope) {
    return { state: "inconsistent" as const, retryWrite: false as const };
  }
  const decisions = await prisma.amuxIdeaUnitDecision.findMany({ where: {
    ideaId, state: "consumed", action: { in: ["create_node", "register_card"] },
  }, select: { action: true, resolvedNodeId: true,
    registeredWorkItemId: true, confirmationSnapshot: true } });
  const nodeIds = decisions.flatMap((decision) =>
    decision.action === "create_node" && decision.resolvedNodeId ?
      [decision.resolvedNodeId] : []);
  const cardIds = decisions.flatMap((decision) =>
    decision.action === "register_card" && decision.registeredWorkItemId ?
      [decision.registeredWorkItemId] : []);
  if (nodeIds.length + cardIds.length !== decisions.length ||
      new Set(nodeIds).size !== nodeIds.length ||
      new Set(cardIds).size !== cardIds.length) {
    return { state: "inconsistent" as const, retryWrite: false as const };
  }
  const assessmentSubjects: Prisma.AmuxPortfolioAssessmentWhereInput[] = [
    ...(nodeIds.length > 0 ? [{ nodeId: { in: nodeIds } }] : []),
    ...(cardIds.length > 0 ? [{ cardId: { in: cardIds } }] : []),
  ];
  const [assessments, scores] = await Promise.all([
    assessmentSubjects.length === 0 ? [] :
      prisma.amuxPortfolioAssessment.findMany({ where: {
        OR: assessmentSubjects,
      }, select: { id: true, approvalAudit: { select: {
        action: true, targetType: true, targetId: true,
        actorUserId: true, actorEmail: true, ipAddress: true, userAgent: true,
        metadata: true, entryHash: true,
      } } } }),
    cardIds.length === 0 ? [] :
      prisma.amuxPortfolioScoreSnapshot.findMany({ where: {
        taskId: { in: cardIds },
      }, select: { id: true, approvalAudit: { select: {
        action: true, targetType: true, targetId: true,
        actorUserId: true, actorEmail: true, ipAddress: true, userAgent: true,
        metadata: true, entryHash: true,
      } } } }),
  ]);
  const assessmentCount = assessments.filter(({ id, approvalAudit }) =>
    isSystemPortfolioAudit(approvalAudit, {
      action: "amux.v4.portfolio.assessment.approve",
      targetType: "AmuxPortfolioAssessment", targetId: id,
      actorScope: AMUX_V19_PORTFOLIO_ASSESSMENT_SCOPE,
    })).length;
  const scoreCount = scores.filter(({ id, approvalAudit }) =>
    isSystemPortfolioAudit(approvalAudit, {
      action: "amux.v4.portfolio.score.confirm",
      targetType: "AmuxPortfolioScoreSnapshot", targetId: id,
      actorScope: AMUX_V19_PORTFOLIO_SCORE_SCOPE,
    })).length;
  const publicPrConsentCount = decisions.filter((decision) => {
    const snapshot = decision.confirmationSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return false;
    }
    const card = (snapshot as Record<string, unknown>).card;
    if (!card || typeof card !== "object" || Array.isArray(card)) return false;
    const task = (card as Record<string, unknown>).task;
    return !!task && typeof task === "object" && !Array.isArray(task) &&
      (task as Record<string, unknown>).publicPrDisclosureApproved === true;
  }).length;
  const expectedMetadata = {
    systemActor: AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR,
    actorScope: AMUX_V19_SYSTEM_REGISTRATION_SCOPE,
    ideaId,
    sourcePlanRevisionId: idea.currentSourcePlanRevisionId,
    operatingScopeSettingId: idea.sessionOperatingScopeSettingId,
    operatingScopeApprovalAuditLogId: operatingScope.approvalAuditLogId,
    nodeCount: nodeIds.length,
    cardCount: cardIds.length,
    assessmentCount,
    scoreCount,
    publicPrConsentCount,
    executionAttempted: false,
  };
  const metadataKeys = Object.keys(expectedMetadata);
  if (Object.keys(metadata).length !== metadataKeys.length ||
      metadataKeys.some((key) => !Object.hasOwn(metadata, key) ||
        metadata[key] !== expectedMetadata[
          key as keyof typeof expectedMetadata])) {
    return { state: "inconsistent" as const, retryWrite: false as const };
  }
  return { state: "committed" as const, retryWrite: false as const,
    ideaId: idea.id, auditId: audit.id };
}
