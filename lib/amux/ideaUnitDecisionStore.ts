import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { AMUX_V4_IDEA_SYSTEM_ACTOR, SYSTEM_AUDIT_ACTOR_METADATA_KEY } from
  "@/lib/adminAuditSystemActors";
import { writeAmuxV4UnitHousekeepingAudit } from
  "@/lib/amux/ideaUnitDecisionSystemAudit";
import { assertRecentAdminAuthentication } from
  "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { type AmuxIdeaDuplicateScan,
  deriveAmuxIdeaUnitConfirmation,
  type AmuxIdeaUnitConfirmationSnapshot } from "./ideaUnitConfirmationCore.ts";
import type { AmuxDigestKey } from "./ideaCrypto.ts";
import { amuxContentDigest, sealAmuxContent,
  type AmuxContentKeys } from "./ideaCrypto.ts";
import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import type { AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";
import { inspectAmuxV4CardRegistration } from "./ideaUnitRegistrationCore.ts";
import { inspectAmuxV4NodeCreation } from "./ideaNodeRegistrationCore.ts";
import { checkAmuxIdeaUnitConsume,
  type AmuxIdeaUnitConsumeContext } from "./ideaUnitConsumeGuard.ts";
import type { V4TaskCostCeilingResult } from "./v4TaskCostCeilingCore.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";

/** A09's protected writer still requires the dedicated environment gate and
 * the route's owner approval before its transaction body is reachable. */
export const AMUX_V4_UNIT_WRITE_CODE_ENABLED = true;
export const AMUX_V4_UNIT_WRITE_ENV = "TOMVERSE_AMUX_V4_UNIT_WRITE";
export const amuxV4UnitWriteEnabled = (value: string | undefined) =>
  AMUX_V4_UNIT_WRITE_CODE_ENABLED && value === "enabled";

export class AmuxV4UnitDecisionError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "not_ready" |
    "reconfirm" | "integrity_unavailable" | "write_disabled" |
    "outcome_unknown" | "duplicate_reason_required") {
    super(code);
    this.name = "AmuxV4UnitDecisionError";
  }
}

/** Read-only preparation refusal: show exact current candidates, then let
 * the owner provide a reason and request a fresh scan and receipt. */
export class AmuxV4DuplicateReasonRequired extends AmuxV4UnitDecisionError {
  constructor(readonly candidateIds: string[]) {
    super("duplicate_reason_required");
  }
}

const ownerId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxV4UnitDecisionError("forbidden");
  }
  return id;
};

async function assertCurrentProposalSource(tx: Prisma.TransactionClient,
  snapshot: AmuxIdeaUnitConfirmationSnapshot, chunkIndex: number) {
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId: snapshot.ideaId, chunkIndex } },
    select: { currentPreviewId: true },
  });
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: snapshot.source.previewId },
    select: { ideaId: true, chunkIndex: true, state: true,
      payloadDigest: true, payloadDigestKeyId: true,
      sourceScopeApprovalId: true },
  });
  if (!chunk || chunk.currentPreviewId !== snapshot.source.previewId ||
      !preview || preview.ideaId !== snapshot.ideaId ||
      preview.chunkIndex !== chunkIndex || preview.state !== "completed" ||
      preview.payloadDigest !== snapshot.source.payload.digest ||
      preview.payloadDigestKeyId !== snapshot.source.payload.keyId ||
      preview.sourceScopeApprovalId !== snapshot.source.scopeApprovalId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  if (snapshot.source.scopeApprovalId !== null) {
    const scope = await tx.amuxIdeaSourceScopeApproval.findUnique({
      where: { id: snapshot.source.scopeApprovalId },
      select: { ideaId: true, scopeDigest: true, scopeDigestKeyId: true },
    });
    if (!scope || scope.ideaId !== snapshot.ideaId ||
        scope.scopeDigest !== snapshot.source.scope?.digest ||
        scope.scopeDigestKeyId !== snapshot.source.scope?.keyId) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  } else if (snapshot.source.scope !== null) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return preview;
}

/** One owner preparation. The caller must construct `snapshot` from fresh,
 * authorized rows and an independently recomputed duplicate scan and price.
 * This function verifies the source and target metadata again in its DB tx.
 * It never creates a card, marks a proposal final, or authorizes execution. */
export async function commitAmuxV4UnitPrepare(tx: Prisma.TransactionClient, input: {
  session: Session;
  request: Request;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  duplicateScan: AmuxIdeaDuplicateScan | null;
  taskCost: V4TaskCostCeilingResult | null;
  digestKey: AmuxDigestKey;
}): Promise<{ decisionId: string; confirmationDigest: string; expiresAt: Date;
  auditId: string }> {
  const actorUserId = ownerId(input.session);
  const { snapshot } = input;
  if (snapshot.actorUserId !== actorUserId) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  const derived = deriveAmuxIdeaUnitConfirmation(snapshot, input.digestKey,
    input.duplicateScan, input.taskCost);
  if (!derived.ok) throw new AmuxV4UnitDecisionError("reconfirm");
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const owned = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${snapshot.ideaId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  if (owned.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
  const unitRows = await tx.$queryRaw<Array<{
    id: string; localRef: string | null; unitKind: string; state: string;
    bodyDigest: string; bodyDigestKeyId: string; expiresAt: Date;
    chunkIndex: number; derivationGroupId: string | null;
  }>>`
    SELECT "id", "localRef", "unitKind", "state", "bodyDigest",
           "bodyDigestKeyId", "expiresAt", "chunkIndex", "derivationGroupId"
    FROM "AmuxIdeaDraftUnit"
    WHERE "id" = ${snapshot.draftUnitId} AND "ideaId" = ${snapshot.ideaId}
      AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  const unit = unitRows[0];
  if (unitRows.length !== 1 || !unit || unit.state !== "proposed" ||
      unit.localRef !== snapshot.localRef || unit.unitKind !== snapshot.unitKind ||
      unit.bodyDigest !== snapshot.unitBody.digest ||
      unit.bodyDigestKeyId !== snapshot.unitBody.keyId) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  if (await tx.amuxIdeaDerivationEdge.count({ where: {
    sourceUnitId: unit.id,
  } }) !== 0) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  if (unit.derivationGroupId !== null) {
    const group = await tx.amuxIdeaDerivationGroup.findFirst({ where: {
      id: unit.derivationGroupId, ideaId: snapshot.ideaId, actorUserId,
    }, select: { id: true, approvalAuditLogId: true, sourceCount: true } });
    const edges = await tx.amuxIdeaDerivationEdge.count({ where: {
      groupId: unit.derivationGroupId, targetUnitId: unit.id,
    } });
    const audit = group ? await tx.adminAuditLog.findUnique({ where: {
      id: group.approvalAuditLogId,
    }, select: { action: true, targetType: true, targetId: true,
      actorUserId: true, entryHash: true } }) : null;
    if (!group || edges !== group.sourceCount || !audit?.entryHash ||
        audit.action !== "amux.v4.derivation.approve" ||
        audit.targetType !== "AmuxIdeaDerivationGroup" ||
        audit.targetId !== group.id || audit.actorUserId !== actorUserId) {
      throw new AmuxV4UnitDecisionError("integrity_unavailable");
    }
  }
  const preview = await assertCurrentProposalSource(tx, snapshot,
    unit.chunkIndex);
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      now >= unit.expiresAt) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  if (snapshot.action === "register_card" && snapshot.hierarchy.length !== 3) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  for (const node of snapshot.hierarchy) {
    const current = await tx.amuxPortfolioNode.findUnique({
      where: { id: node.id }, select: { level: true, parentId: true,
        revision: true, contentDigest: true, contentDigestKeyId: true,
        state: true },
    });
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: node.id, revision: node.revision } },
      select: { decisionId: true, contentDigest: true,
        contentDigestKeyId: true },
    });
    const approval = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { action: true, state: true, resolvedNodeId: true },
    }) : null;
    if (!current || !revision || current.state !== "active" ||
        current.level !== node.level || current.parentId !== node.parentId ||
        current.revision !== node.revision ||
        current.contentDigest !== node.content.digest ||
        current.contentDigestKeyId !== node.content.keyId ||
        revision.decisionId !== node.approvedDecisionId ||
        approval?.action !== "create_node" || approval.state !== "consumed" ||
        approval.resolvedNodeId !== node.id ||
        revision.contentDigest !== node.content.digest ||
        revision.contentDigestKeyId !== node.content.keyId) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const baseNode = snapshot.action === "register_card"
    ? snapshot.hierarchy.at(-1) ?? null :
    snapshot.target?.kind === "node" ? snapshot.target : null;
  const baseCard = snapshot.target?.kind === "card" ? snapshot.target : null;
  if (baseNode) {
    const row = await tx.amuxPortfolioNode.findUnique({
      where: { id: baseNode.id }, select: { revision: true,
        contentDigest: true, contentDigestKeyId: true, state: true },
    });
    if (!row || row.state !== "active" || row.revision !== baseNode.revision ||
        row.contentDigest !== baseNode.content.digest ||
        row.contentDigestKeyId !== baseNode.content.keyId) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  if (baseCard) {
    const row = await tx.amuxWorkItem.findUnique({
      where: { id: baseCard.id }, select: { revision: true, sourceSystem: true,
        v4TitleDigest: true, v4TitleDigestKeyId: true, status: true },
    });
    if (!row || row.sourceSystem !== "admin-idea-v4" ||
        row.status === "cancelled" || row.revision !== baseCard.revision ||
        row.v4TitleDigest !== baseCard.content.digest ||
        row.v4TitleDigestKeyId !== baseCard.content.keyId) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.prepare",
    targetType: "AmuxIdeaUnitDecision", targetId: snapshot.decisionId,
    summary: "Prepared one AMUX v4 unit decision without registering a card.",
    metadata: { ideaId: snapshot.ideaId, draftUnitId: snapshot.draftUnitId,
      action: snapshot.action, unitDigest: snapshot.unitBody.digest,
      confirmationDigest: derived.confirmationDigest,
      sourcePreviewId: snapshot.source.previewId },
  });
  const row = await tx.amuxIdeaUnitDecision.create({ data: {
    id: snapshot.decisionId, ideaId: snapshot.ideaId,
    draftUnitId: snapshot.draftUnitId, actorUserId,
    chunkIndex: preview.chunkIndex, prepareRequestId: snapshot.prepareRequestId,
    action: snapshot.action, state: "prepared",
    ownerSessionDigest: snapshot.ownerSession.digest,
    ownerSessionDigestKeyId: snapshot.ownerSession.keyId,
    unitDigest: snapshot.unitBody.digest,
    unitDigestKeyId: snapshot.unitBody.keyId,
    confirmationDigest: derived.confirmationDigest,
    confirmationDigestKeyId: derived.digestKeyId,
    confirmationSnapshot: snapshot,
    sourcePreviewId: snapshot.source.previewId,
    sourcePreviewDigest: snapshot.source.payload.digest,
    sourcePreviewDigestKeyId: snapshot.source.payload.keyId,
    baseNodeId: baseNode?.id ?? null,
    baseNodeRevision: baseNode?.revision ?? null,
    baseNodeDigest: baseNode?.content.digest ?? null,
    baseNodeDigestKeyId: baseNode?.content.keyId ?? null,
    baseWorkItemId: baseCard?.id ?? null,
    baseWorkItemRevision: baseCard?.revision ?? null,
    baseWorkItemDigest: baseCard?.content.digest ?? null,
    baseWorkItemDigestKeyId: baseCard?.content.keyId ?? null,
    preparedAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000),
    prepareAuditLogId: auditId,
  }, select: { id: true, expiresAt: true } });
  return { decisionId: row.id, confirmationDigest: derived.confirmationDigest,
    expiresAt: row.expiresAt, auditId };
}

/** Consume exactly one prepared card decision. `proposal` must be decrypted
 * from the current draft unit, and `recalculate` must read the current board
 * and approved Task price inside this transaction after the audit lock. A
 * caller-provided preview or model suggestion never bypasses these checks. */
export async function commitAmuxV4CardRegistration(tx: Prisma.TransactionClient, input: {
  session: Session;
  request: Request;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisCard;
  context: Omit<AmuxIdeaUnitConsumeContext, "databaseNow" | "currentConfirmation">;
  consumeRequestId: string;
  cardId: string;
  keys: AmuxContentKeys;
  recalculate: (tx: Prisma.TransactionClient) => Promise<{
    duplicateScan: AmuxIdeaDuplicateScan;
    taskCost: V4TaskCostCeilingResult | null;
  }>;
}): Promise<{ decisionId: string; cardId: string; auditId: string }> {
  const actorUserId = ownerId(input.session);
  if (input.snapshot.actorUserId !== actorUserId ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(input.cardId) ||
      !/^[0-9a-f-]{36}$/.test(input.consumeRequestId)) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${input.snapshot.decisionId}
      AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
  const prepared = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: input.snapshot.decisionId },
  });
  if (!prepared || prepared.action !== "register_card" ||
      prepared.actorUserId !== actorUserId) {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  if (prepared.confirmationSnapshot === null ||
      amuxCanonicalJson(prepared.confirmationSnapshot) !==
        amuxCanonicalJson(input.snapshot)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxV4UnitDecisionError("integrity_unavailable");
  }
  await assertCurrentProposalSource(tx, input.snapshot, prepared.chunkIndex);
  // Lock each reviewed hierarchy row before the duplicate scan and card
  // insert. A changed or archived parent invalidates the old receipt.
  const hierarchy = input.snapshot.hierarchy;
  if (hierarchy.length !== 3) throw new AmuxV4UnitDecisionError("reconfirm");
  for (const target of hierarchy) {
    const nodes = await tx.$queryRaw<Array<{
      id: string; level: string; parentId: string | null; state: string;
      revision: number; contentDigest: string; contentDigestKeyId: string;
    }>>`
      SELECT "id", "level", "parentId", "state", "revision",
             "contentDigest", "contentDigestKeyId"
      FROM "AmuxPortfolioNode" WHERE "id" = ${target.id} FOR SHARE
    `;
    const current = nodes[0];
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: target.id,
        revision: target.revision } },
      select: { decisionId: true, contentDigest: true,
        contentDigestKeyId: true },
    });
    const approval = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { action: true, state: true, resolvedNodeId: true },
    }) : null;
    if (nodes.length !== 1 || !current || current.level !== target.level ||
        current.parentId !== target.parentId || current.state !== "active" ||
        current.revision !== target.revision ||
        current.contentDigest !== target.content.digest ||
        current.contentDigestKeyId !== target.content.keyId ||
        !revision || revision.decisionId !== target.approvedDecisionId ||
        revision.contentDigest !== target.content.digest ||
        revision.contentDigestKeyId !== target.content.keyId ||
        approval?.action !== "create_node" || approval.state !== "consumed" ||
        approval.resolvedNodeId !== target.id) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const refs = [input.snapshot.card?.parentStory ?? null,
    ...(input.snapshot.card?.dependencies ?? [])].filter((value): value is NonNullable<typeof value> => value !== null);
  for (const target of refs) {
    const rows = await tx.$queryRaw<Array<{
      id: string; sourceSystem: string | null; cardType: string | null;
      parentFeatureNodeId: string | null; status: string; revision: number;
      v4TitleDigest: string | null; v4TitleDigestKeyId: string | null;
      archivedAt: Date | null; v4SourceApprovalId: string | null;
    }>>`
      SELECT "id", "sourceSystem", "cardType", "parentFeatureNodeId",
             "status", "revision", "v4TitleDigest", "v4TitleDigestKeyId",
             "archivedAt", "v4SourceApprovalId"
      FROM "AmuxWorkItem" WHERE "id" = ${target.id} FOR SHARE
    `;
    const current = rows[0];
    const referenceApproval = current?.v4SourceApprovalId ?
      await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: current.v4SourceApprovalId },
        select: { action: true, state: true, registeredWorkItemId: true },
      }) : null;
    if (rows.length !== 1 || !current ||
        current.sourceSystem !== "admin-idea-v4" ||
        current.cardType !== target.cardType ||
        current.parentFeatureNodeId !== target.featureNodeId ||
        current.archivedAt !== null || current.status === "cancelled" ||
        current.status !== target.status ||
        current.revision !== target.revision ||
        current.v4TitleDigest !== target.content.digest ||
        current.v4TitleDigestKeyId !== target.content.keyId ||
        referenceApproval?.action !== "register_card" ||
        referenceApproval.state !== "consumed" ||
        referenceApproval.registeredWorkItemId !== current.id) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const evidence = await input.recalculate(tx);
  const confirmation = deriveAmuxIdeaUnitConfirmation(input.snapshot,
    input.keys, evidence.duplicateScan, evidence.taskCost);
  const inspected = inspectAmuxV4CardRegistration({
    prepared: { ...prepared, state: prepared.state as "prepared" | "consumed" | "cancelled" | "invalidated" | "expired" },
    context: { ...input.context, databaseNow: now,
      currentConfirmation: confirmation }, confirmation,
    snapshot: input.snapshot, proposal: input.proposal,
    digestKey: input.keys,
    resolvedFeatureRef: hierarchy[2].id,
  });
  if (!inspected.ok) {
    throw new AmuxV4UnitDecisionError(inspected.code === "halt"
      ? "integrity_unavailable" : "reconfirm");
  }
  const plan = inspected.plan;
  const title = sealAmuxContent(Buffer.from(plan.title, "utf8"),
    "card_title", input.cardId, input.keys);
  const body = sealAmuxContent(Buffer.from(amuxCanonicalJson(plan.body), "utf8"),
    "card_body", input.cardId, input.keys);
  const brief = plan.executionBrief === null ? null : sealAmuxContent(
    Buffer.from(plan.executionBrief, "utf8"), "card_brief", input.cardId, input.keys);
  await tx.amuxWorkItem.create({ data: {
    id: input.cardId, title: plan.cardType === "story" ? "AMUX Story" : "AMUX Task",
    description: null, status: "backlog", kind: "unknown", priority: "p3",
    owner: null, claimedAt: null, revision: 0,
    sourceSystem: plan.sourceSystem, sourceKey: plan.sourceKey,
    sourceVersion: "1", sourceDigest: plan.sourceDigest,
    sourceSnapshot: { schemaVersion: "amux-v4", ideaId: plan.ideaId,
      approvalId: plan.decisionId },
    cardType: plan.cardType, storyKind: plan.storyKind,
    parentFeatureNodeId: plan.featureNodeId,
    parentStoryCardId: plan.parentStoryCardId,
    v4TitleCiphertext: new Uint8Array(title.ciphertext),
    v4TitleKeyId: title.keyId, v4TitleKeyVersion: title.keyVersion,
    v4TitleDigest: title.digest, v4TitleDigestKeyId: title.digestKeyId,
    v4BodyCiphertext: new Uint8Array(body.ciphertext),
    v4BodyKeyId: body.keyId, v4BodyKeyVersion: body.keyVersion,
    v4BodyDigest: body.digest, v4BodyDigestKeyId: body.digestKeyId,
    v4BriefCiphertext: brief ? new Uint8Array(brief.ciphertext) : null,
    v4BriefKeyId: brief?.keyId ?? null,
    v4BriefKeyVersion: brief?.keyVersion ?? null,
    v4BriefDigest: brief?.digest ?? null,
    v4BriefDigestKeyId: brief?.digestKeyId ?? null,
    v4SourceApprovalId: plan.decisionId,
    taskRole: plan.taskRole, executionGrade: plan.executionGrade,
    // The approved Task ceiling lives only in the immutable unit receipt.
    // This legacy estimate column is not that approval authority.
    estimatedCostMicrousd: null,
  } });
  if (plan.dependencyIds.length > 0) {
    await tx.amuxWorkDependency.createMany({ data: plan.dependencyIds.map(
      (dependencyId) => ({ taskId: input.cardId, dependencyId })) });
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.consume",
    targetType: "AmuxIdeaUnitDecision", targetId: plan.decisionId,
    summary: "Consumed one owner-confirmed AMUX v4 card into inert backlog.",
    metadata: { ideaId: plan.ideaId, draftUnitId: plan.draftUnitId,
      cardId: input.cardId, action: "register_card", status: "backlog",
      confirmationDigest: prepared.confirmationDigest,
      publicPrDisclosureApproved:
        input.snapshot.card?.task?.publicPrDisclosureApproved === true,
      ownerAssigned: false, executionAttempted: false },
  });
  const consumed = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: plan.decisionId, actorUserId, state: "prepared",
      confirmationDigest: confirmation.ok ? confirmation.confirmationDigest : "",
      expiresAt: { gt: now }, outcomeUnknownAt: null },
    data: { state: "consumed", consumeRequestId: input.consumeRequestId,
      consumedAt: now, finalAuditLogId: auditId,
      registeredWorkItemId: input.cardId },
  });
  if (consumed.count !== 1) throw new AmuxV4UnitDecisionError("reconfirm");
  const finalized = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: plan.draftUnitId, ideaId: plan.ideaId, actorUserId,
      state: "proposed" }, data: { state: "approved" },
  });
  if (finalized.count !== 1) throw new AmuxV4UnitDecisionError("reconfirm");
  return { decisionId: plan.decisionId, cardId: input.cardId, auditId };
}

/** One node, one approval, one revision and one finalized draft in a single
 * transaction. No card or worker is created by this hierarchy operation. */
export async function commitAmuxV4NodeCreation(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisNode;
  context: Omit<AmuxIdeaUnitConsumeContext, "databaseNow" | "currentConfirmation">;
  consumeRequestId: string; keys: AmuxContentKeys;
  recalculate: (tx: Prisma.TransactionClient) => Promise<AmuxIdeaDuplicateScan>;
}): Promise<{ decisionId: string; nodeId: string; auditId: string }> {
  const actorUserId = ownerId(input.session);
  if (input.snapshot.actorUserId !== actorUserId ||
      input.snapshot.action !== "create_node" ||
      !/^[0-9a-f-]{36}$/.test(input.consumeRequestId)) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${input.snapshot.decisionId}
      AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
  const prepared = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: input.snapshot.decisionId },
  });
  if (!prepared || prepared.action !== "create_node" ||
      prepared.actorUserId !== actorUserId ||
      prepared.confirmationSnapshot === null ||
      amuxCanonicalJson(prepared.confirmationSnapshot) !==
        amuxCanonicalJson(input.snapshot)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxV4UnitDecisionError("integrity_unavailable");
  }
  await assertCurrentProposalSource(tx, input.snapshot, prepared.chunkIndex);
  for (const target of input.snapshot.hierarchy) {
    const nodes = await tx.$queryRaw<Array<{
      id: string; level: string; parentId: string | null; state: string;
      revision: number; contentDigest: string; contentDigestKeyId: string;
    }>>`
      SELECT "id", "level", "parentId", "state", "revision",
             "contentDigest", "contentDigestKeyId"
      FROM "AmuxPortfolioNode" WHERE "id" = ${target.id} FOR SHARE
    `;
    const node = nodes[0];
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: target.id,
        revision: target.revision } },
      select: { decisionId: true, contentDigest: true,
        contentDigestKeyId: true },
    });
    const approval = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { action: true, state: true, resolvedNodeId: true },
    }) : null;
    if (nodes.length !== 1 || !node || node.state !== "active" ||
        node.level !== target.level || node.parentId !== target.parentId ||
        node.revision !== target.revision ||
        node.contentDigest !== target.content.digest ||
        node.contentDigestKeyId !== target.content.keyId ||
        !revision || revision.decisionId !== target.approvedDecisionId ||
        revision.contentDigest !== target.content.digest ||
        revision.contentDigestKeyId !== target.content.keyId ||
        approval?.action !== "create_node" || approval.state !== "consumed" ||
        approval.resolvedNodeId !== target.id) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const duplicates = await input.recalculate(tx);
  const confirmation = deriveAmuxIdeaUnitConfirmation(input.snapshot,
    input.keys, duplicates, null);
  const inspected = inspectAmuxV4NodeCreation({
    prepared: { ...prepared, state: prepared.state as
      "prepared" | "consumed" | "cancelled" | "invalidated" | "expired" },
    context: { ...input.context, databaseNow: now,
      currentConfirmation: confirmation }, confirmation,
    snapshot: input.snapshot, proposal: input.proposal,
    digestKey: input.keys,
  });
  if (!inspected.ok) throw new AmuxV4UnitDecisionError(inspected.code === "halt"
    ? "integrity_unavailable" : "reconfirm");
  const plan = inspected.plan;
  const title = sealAmuxContent(Buffer.from(plan.title, "utf8"),
    "node_content", plan.id, input.keys);
  const description = sealAmuxContent(Buffer.from(plan.description, "utf8"),
    "node_content", plan.id, input.keys);
  const content = amuxContentDigest(Buffer.from(amuxCanonicalJson({
    title: plan.title, description: plan.description }), "utf8"),
  "node_content", plan.id, input.keys);
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.consume",
    targetType: "AmuxIdeaUnitDecision", targetId: plan.decisionId,
    summary: "Consumed one owner-confirmed AMUX v4 portfolio node.",
    metadata: { ideaId: plan.ideaId, draftUnitId: plan.draftUnitId,
      nodeId: plan.id, action: "create_node",
      confirmationDigest: prepared.confirmationDigest,
      executionAttempted: false },
  });
  await tx.amuxPortfolioNode.create({ data: {
    id: plan.id, level: plan.level, parentId: plan.parentId,
    state: "active", revision: 0,
    titleCiphertext: new Uint8Array(title.ciphertext),
    descriptionCiphertext: new Uint8Array(description.ciphertext),
    contentKeyId: title.keyId, contentKeyVersion: title.keyVersion,
    contentDigest: content.digest, contentDigestKeyId: content.digestKeyId,
    approvedByUserId: actorUserId, authorizationAuditLogId: auditId,
  } });
  await tx.amuxPortfolioNodeRevision.create({ data: {
    id: randomUUID(), nodeId: plan.id, revision: 0,
    priorRevision: null, parentIdAtApproval: plan.parentId,
    contentDigest: content.digest, contentDigestKeyId: content.digestKeyId,
    decisionId: plan.decisionId, authorizationAuditLogId: auditId,
    approvedAt: now,
  } });
  const consumed = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: plan.decisionId, actorUserId, state: "prepared",
      confirmationDigest: confirmation.ok ? confirmation.confirmationDigest : "",
      expiresAt: { gt: now }, outcomeUnknownAt: null },
    data: { state: "consumed", consumeRequestId: input.consumeRequestId,
      consumedAt: now, finalAuditLogId: auditId, resolvedNodeId: plan.id },
  });
  if (consumed.count !== 1) throw new AmuxV4UnitDecisionError("reconfirm");
  const finalized = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: plan.draftUnitId, ideaId: plan.ideaId,
      actorUserId, state: "proposed" }, data: { state: "approved" },
  });
  if (finalized.count !== 1) throw new AmuxV4UnitDecisionError("reconfirm");
  return { decisionId: plan.decisionId, nodeId: plan.id, auditId };
}

/** A rejected proposal is a consumed owner decision with no card or node.
 * Rejection does not delete the draft or mutate any previously approved unit. */
export async function commitAmuxV4UnitRejection(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisCard | AmuxAnalysisNode;
  context: Omit<AmuxIdeaUnitConsumeContext, "databaseNow" | "currentConfirmation">;
  consumeRequestId: string; keys: AmuxDigestKey;
}) {
  const actorUserId = ownerId(input.session);
  if (input.snapshot.actorUserId !== actorUserId ||
      input.snapshot.action !== "reject_unit" ||
      !/^[0-9a-f-]{36}$/.test(input.consumeRequestId)) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${input.snapshot.decisionId}
      AND "actorUserId" = ${actorUserId} FOR UPDATE
  `;
  if (rows.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
  const prepared = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: input.snapshot.decisionId },
  });
  if (!prepared || prepared.action !== "reject_unit" ||
      prepared.confirmationSnapshot === null ||
      amuxCanonicalJson(prepared.confirmationSnapshot) !==
        amuxCanonicalJson(input.snapshot)) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const unit = await tx.amuxIdeaDraftUnit.findUnique({
    where: { id: prepared.draftUnitId },
    select: { id: true, ideaId: true, actorUserId: true, chunkIndex: true,
      localRef: true, unitKind: true, state: true, bodyDigest: true,
      bodyDigestKeyId: true },
  });
  if (!unit || unit.ideaId !== prepared.ideaId ||
      unit.actorUserId !== actorUserId || unit.state !== "proposed" ||
      unit.localRef !== input.proposal.localId ||
      unit.localRef !== input.snapshot.localRef ||
      unit.unitKind !== input.proposal.kind ||
      unit.bodyDigest !== input.snapshot.unitBody.digest ||
      unit.bodyDigestKeyId !== input.snapshot.unitBody.keyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  await assertCurrentProposalSource(tx, input.snapshot, unit.chunkIndex);
  const actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(input.proposal), "utf8"),
    "analysis_draft", unit.id, input.keys);
  if (actual.digest !== unit.bodyDigest ||
      actual.digestKeyId !== unit.bodyDigestKeyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxV4UnitDecisionError("integrity_unavailable");
  }
  const confirmation = deriveAmuxIdeaUnitConfirmation(input.snapshot,
    input.keys, null, null);
  const guard = checkAmuxIdeaUnitConsume({ ...prepared,
    state: prepared.state as "prepared" | "consumed" | "cancelled" | "invalidated" | "expired" },
  { ...input.context, databaseNow: now, currentConfirmation: confirmation });
  if (guard.decision !== "allow") {
    throw new AmuxV4UnitDecisionError(guard.decision === "halt" ?
      "integrity_unavailable" : "reconfirm");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.consume",
    targetType: "AmuxIdeaUnitDecision", targetId: prepared.id,
    summary: "Rejected one AMUX v4 proposal without registering a target.",
    metadata: { ideaId: prepared.ideaId, draftUnitId: unit.id,
      action: "reject_unit", confirmationDigest: prepared.confirmationDigest,
      targetCreated: false },
  });
  const decision = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: prepared.id, actorUserId, state: "prepared",
      expiresAt: { gt: now }, outcomeUnknownAt: null,
      confirmationDigest: confirmation.ok ? confirmation.confirmationDigest : "" },
    data: { state: "consumed", consumeRequestId: input.consumeRequestId,
      consumedAt: now, finalAuditLogId: auditId },
  });
  const draft = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: unit.id, ideaId: prepared.ideaId,
      actorUserId, state: "proposed" },
    data: { state: "rejected" },
  });
  if (decision.count !== 1 || draft.count !== 1) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return { decisionId: prepared.id, auditId, targetCreated: false as const };
}

/** Bind one proposal to an existing approved node; no node body or execution
 * state is changed. The decision row itself is the append-only link. */
export async function commitAmuxV4NodeSelection(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisNode;
  context: Omit<AmuxIdeaUnitConsumeContext, "databaseNow" | "currentConfirmation">;
  consumeRequestId: string; keys: AmuxDigestKey;
  recalculate: (tx: Prisma.TransactionClient) => Promise<AmuxIdeaDuplicateScan>;
}) {
  const actorUserId = ownerId(input.session);
  const { snapshot } = input;
  if (snapshot.actorUserId !== actorUserId ||
      !["select_existing_node", "link_existing_node"].includes(snapshot.action) ||
      snapshot.target?.kind !== "node" ||
      !/^[0-9a-f-]{36}$/.test(input.consumeRequestId)) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${snapshot.decisionId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
  const prepared = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: snapshot.decisionId },
  });
  if (!prepared || prepared.action !== snapshot.action ||
      prepared.confirmationSnapshot === null ||
      amuxCanonicalJson(prepared.confirmationSnapshot) !==
        amuxCanonicalJson(snapshot) ||
      prepared.baseNodeId !== snapshot.target.id ||
      prepared.baseNodeRevision !== snapshot.target.revision ||
      prepared.baseNodeDigest !== snapshot.target.content.digest ||
      prepared.baseNodeDigestKeyId !== snapshot.target.content.keyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const unit = await tx.amuxIdeaDraftUnit.findUnique({
    where: { id: prepared.draftUnitId },
    select: { id: true, ideaId: true, actorUserId: true, state: true,
      localRef: true, unitKind: true, bodyDigest: true,
      bodyDigestKeyId: true, chunkIndex: true },
  });
  if (!unit || unit.ideaId !== prepared.ideaId ||
      unit.actorUserId !== actorUserId || unit.state !== "proposed" ||
      unit.unitKind !== "node" || unit.localRef !== input.proposal.localId ||
      unit.bodyDigest !== snapshot.unitBody.digest ||
      unit.bodyDigestKeyId !== snapshot.unitBody.keyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(input.proposal), "utf8"),
    "analysis_draft", unit.id, input.keys);
  if (actual.digest !== unit.bodyDigest ||
      actual.digestKeyId !== unit.bodyDigestKeyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  await assertCurrentProposalSource(tx, snapshot, unit.chunkIndex);
  const path = [...snapshot.hierarchy, snapshot.target];
  for (const target of path) {
    const rows = await tx.$queryRaw<Array<{
      id: string; level: string; parentId: string | null;
      state: string; revision: number;
      contentDigest: string; contentDigestKeyId: string;
    }>>`
      SELECT "id", "level", "parentId", "state", "revision",
             "contentDigest", "contentDigestKeyId"
      FROM "AmuxPortfolioNode" WHERE "id" = ${target.id} FOR SHARE
    `;
    const node = rows[0];
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: target.id,
        revision: target.revision } },
      select: { decisionId: true, contentDigest: true,
        contentDigestKeyId: true },
    });
    const approval = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { action: true, state: true, resolvedNodeId: true },
    }) : null;
    if (rows.length !== 1 || !node || node.state !== "active" ||
        node.level !== target.level || node.parentId !== target.parentId ||
        node.revision !== target.revision ||
        node.contentDigest !== target.content.digest ||
        node.contentDigestKeyId !== target.content.keyId ||
        revision?.decisionId !== target.approvedDecisionId ||
        revision.contentDigest !== target.content.digest ||
        revision.contentDigestKeyId !== target.content.keyId ||
        approval?.action !== "create_node" || approval.state !== "consumed" ||
        approval.resolvedNodeId !== target.id) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const duplicates = await input.recalculate(tx);
  const confirmation = deriveAmuxIdeaUnitConfirmation(snapshot,
    input.keys, duplicates, null);
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxV4UnitDecisionError("integrity_unavailable");
  }
  const guard = checkAmuxIdeaUnitConsume({ ...prepared,
    state: prepared.state as "prepared" | "consumed" | "cancelled" | "invalidated" | "expired" },
  { ...input.context, databaseNow: now, currentConfirmation: confirmation });
  if (guard.decision !== "allow") {
    throw new AmuxV4UnitDecisionError(guard.decision === "halt" ?
      "integrity_unavailable" : "reconfirm");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.consume",
    targetType: "AmuxIdeaUnitDecision", targetId: prepared.id,
    summary: "Linked one AMUX v4 proposal to an approved portfolio node.",
    metadata: { ideaId: prepared.ideaId, draftUnitId: unit.id,
      nodeId: snapshot.target.id, action: snapshot.action,
      confirmationDigest: prepared.confirmationDigest,
      targetCreated: false },
  });
  const decision = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: prepared.id, actorUserId, state: "prepared",
      expiresAt: { gt: now }, outcomeUnknownAt: null,
      confirmationDigest: confirmation.ok ? confirmation.confirmationDigest : "" },
    data: { state: "consumed", consumeRequestId: input.consumeRequestId,
      consumedAt: now, finalAuditLogId: auditId,
      linkedNodeId: snapshot.target.id },
  });
  const draft = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: unit.id, ideaId: prepared.ideaId,
      actorUserId, state: "proposed" }, data: { state: "approved" },
  });
  if (decision.count !== 1 || draft.count !== 1) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return { decisionId: prepared.id, nodeId: snapshot.target.id,
    auditId, targetCreated: false as const };
}

/** Link one proposed Story/Task to a typed existing v4 card. No new Task,
 * execution brief, dependency or worker state is created by this action. */
export async function commitAmuxV4CardLink(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisCard;
  context: Omit<AmuxIdeaUnitConsumeContext, "databaseNow" | "currentConfirmation">;
  consumeRequestId: string; keys: AmuxDigestKey;
  recalculate: (tx: Prisma.TransactionClient) => Promise<AmuxIdeaDuplicateScan>;
}) {
  const actorUserId = ownerId(input.session);
  const { snapshot } = input;
  if (snapshot.actorUserId !== actorUserId ||
      snapshot.action !== "link_existing_card" ||
      snapshot.target?.kind !== "card" ||
      !/^[0-9a-f-]{36}$/.test(input.consumeRequestId)) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaUnitDecision"
    WHERE "id" = ${snapshot.decisionId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
  const prepared = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: snapshot.decisionId },
  });
  if (!prepared || prepared.action !== "link_existing_card" ||
      prepared.confirmationSnapshot === null ||
      amuxCanonicalJson(prepared.confirmationSnapshot) !==
        amuxCanonicalJson(snapshot) ||
      prepared.baseWorkItemId !== snapshot.target.id ||
      prepared.baseWorkItemRevision !== snapshot.target.revision ||
      prepared.baseWorkItemDigest !== snapshot.target.content.digest ||
      prepared.baseWorkItemDigestKeyId !== snapshot.target.content.keyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const unit = await tx.amuxIdeaDraftUnit.findUnique({
    where: { id: prepared.draftUnitId },
    select: { id: true, ideaId: true, actorUserId: true, state: true,
      localRef: true, unitKind: true, bodyDigest: true,
      bodyDigestKeyId: true, chunkIndex: true },
  });
  if (!unit || unit.ideaId !== prepared.ideaId ||
      unit.actorUserId !== actorUserId || unit.state !== "proposed" ||
      unit.unitKind !== "card" || unit.localRef !== input.proposal.localId ||
      unit.bodyDigest !== snapshot.unitBody.digest ||
      unit.bodyDigestKeyId !== snapshot.unitBody.keyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(input.proposal), "utf8"),
    "analysis_draft", unit.id, input.keys);
  if (actual.digest !== unit.bodyDigest ||
      actual.digestKeyId !== unit.bodyDigestKeyId) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  await assertCurrentProposalSource(tx, snapshot, unit.chunkIndex);
  if (snapshot.hierarchy.length !== 3) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  for (const target of snapshot.hierarchy) {
    const rows = await tx.$queryRaw<Array<{
      id: string; level: string; parentId: string | null;
      state: string; revision: number;
      contentDigest: string; contentDigestKeyId: string;
    }>>`
      SELECT "id", "level", "parentId", "state", "revision",
             "contentDigest", "contentDigestKeyId"
      FROM "AmuxPortfolioNode" WHERE "id" = ${target.id} FOR SHARE
    `;
    const node = rows[0];
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: target.id,
        revision: target.revision } },
      select: { decisionId: true, contentDigest: true,
        contentDigestKeyId: true },
    });
    const approval = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { action: true, state: true, resolvedNodeId: true },
    }) : null;
    if (rows.length !== 1 || !node || node.state !== "active" ||
        node.level !== target.level || node.parentId !== target.parentId ||
        node.revision !== target.revision ||
        node.contentDigest !== target.content.digest ||
        node.contentDigestKeyId !== target.content.keyId ||
        revision?.decisionId !== target.approvedDecisionId ||
        revision.contentDigest !== target.content.digest ||
        revision.contentDigestKeyId !== target.content.keyId ||
        approval?.action !== "create_node" || approval.state !== "consumed" ||
        approval.resolvedNodeId !== target.id) {
      throw new AmuxV4UnitDecisionError("reconfirm");
    }
  }
  const target = snapshot.target;
  const cards = await tx.$queryRaw<Array<{
    id: string; sourceSystem: string | null; cardType: string | null;
    storyKind: string | null; parentFeatureNodeId: string | null;
    status: string; revision: number; archivedAt: Date | null;
    v4TitleDigest: string | null; v4TitleDigestKeyId: string | null;
    v4SourceApprovalId: string | null;
  }>>`
    SELECT "id", "sourceSystem", "cardType", "storyKind",
           "parentFeatureNodeId", "status", "revision", "archivedAt",
           "v4TitleDigest", "v4TitleDigestKeyId", "v4SourceApprovalId"
    FROM "AmuxWorkItem" WHERE "id" = ${target.id} FOR SHARE
  `;
  const card = cards[0];
  const sourceApproval = card?.v4SourceApprovalId ?
    await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: card.v4SourceApprovalId },
      select: { action: true, state: true, registeredWorkItemId: true },
    }) : null;
  if (cards.length !== 1 || !card || card.sourceSystem !== "admin-idea-v4" ||
      card.cardType !== target.cardType ||
      card.storyKind !== target.storyKind ||
      card.parentFeatureNodeId !== target.featureNodeId ||
      card.status !== target.status || card.status === "cancelled" ||
      card.archivedAt !== null || card.revision !== target.revision ||
      card.v4TitleDigest !== target.content.digest ||
      card.v4TitleDigestKeyId !== target.content.keyId ||
      sourceApproval?.action !== "register_card" ||
      sourceApproval.state !== "consumed" ||
      sourceApproval.registeredWorkItemId !== card.id) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  const duplicates = await input.recalculate(tx);
  const confirmation = deriveAmuxIdeaUnitConfirmation(snapshot,
    input.keys, duplicates, null);
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxV4UnitDecisionError("integrity_unavailable");
  }
  const guard = checkAmuxIdeaUnitConsume({ ...prepared,
    state: prepared.state as "prepared" | "consumed" | "cancelled" | "invalidated" | "expired" },
  { ...input.context, databaseNow: now, currentConfirmation: confirmation });
  if (guard.decision !== "allow") {
    throw new AmuxV4UnitDecisionError(guard.decision === "halt" ?
      "integrity_unavailable" : "reconfirm");
  }
  const auditId = await writeAdminAuditLog({ tx, session: input.session,
    request: input.request, action: "amux.v4.unit.consume",
    targetType: "AmuxIdeaUnitDecision", targetId: prepared.id,
    summary: "Linked one AMUX v4 proposal to an approved backlog card.",
    metadata: { ideaId: prepared.ideaId, draftUnitId: unit.id,
      cardId: target.id, action: "link_existing_card",
      confirmationDigest: prepared.confirmationDigest,
      targetCreated: false },
  });
  const decision = await tx.amuxIdeaUnitDecision.updateMany({
    where: { id: prepared.id, actorUserId, state: "prepared",
      expiresAt: { gt: now }, outcomeUnknownAt: null,
      confirmationDigest: confirmation.ok ? confirmation.confirmationDigest : "" },
    data: { state: "consumed", consumeRequestId: input.consumeRequestId,
      consumedAt: now, finalAuditLogId: auditId,
      linkedWorkItemId: target.id },
  });
  const draft = await tx.amuxIdeaDraftUnit.updateMany({
    where: { id: unit.id, ideaId: prepared.ideaId,
      actorUserId, state: "proposed" }, data: { state: "approved" },
  });
  if (decision.count !== 1 || draft.count !== 1) {
    throw new AmuxV4UnitDecisionError("reconfirm");
  }
  return { decisionId: prepared.id, cardId: target.id,
    auditId, targetCreated: false as const };
}

/** Exact-ID read-back after an uncertain response. Missing is not proof of
 * no commit and must never trigger an automatic second write. */
export async function readAmuxV4UnitDecision(session: Session, lookup: {
  decisionId?: string; prepareRequestId?: string;
}) {
  const actorUserId = ownerId(session);
  if ((lookup.decisionId === undefined) ===
        (lookup.prepareRequestId === undefined) ||
      (lookup.decisionId !== undefined &&
        !/^[A-Za-z0-9_-]{8,80}$/.test(lookup.decisionId)) ||
      (lookup.prepareRequestId !== undefined &&
        !/^[a-f0-9-]{36}$/.test(lookup.prepareRequestId))) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  const row = await prisma.amuxIdeaUnitDecision.findFirst({
    where: { actorUserId,
      ...(lookup.decisionId === undefined ?
        { prepareRequestId: lookup.prepareRequestId } :
        { id: lookup.decisionId }) },
    select: { id: true, ideaId: true, draftUnitId: true, state: true,
      action: true, confirmationDigest: true, expiresAt: true,
      outcomeUnknownAt: true, registeredWorkItemId: true,
      outcomeUnknownConsumeRequestId: true,
      outcomeUnknownAuditLogId: true,
      outcomeUnknownResolvedAt: true,
      outcomeUnknownResolvedAuditLogId: true,
      resolvedNodeId: true, linkedNodeId: true,
      linkedWorkItemId: true, baseWorkItemId: true,
      baseNodeId: true, baseNodeRevision: true,
      baseNodeDigest: true, baseNodeDigestKeyId: true,
      prepareAuditLogId: true, finalAuditLogId: true },
  });
  if (!row) return { state: "not_visible", retryWrite: false } as const;
  const [prepareAudit, finalAudit, card, nodeRevision, node, decisionDraft,
    linkedNode, linkedRevision, linkedCard, unknownAudit,
    unknownResolvedAudit] = await Promise.all([
    prisma.adminAuditLog.findUnique({ where: { id: row.prepareAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true } }),
    row.finalAuditLogId ? prisma.adminAuditLog.findUnique({
      where: { id: row.finalAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true },
    }) : Promise.resolve(null),
    row.registeredWorkItemId ? prisma.amuxWorkItem.findUnique({
      where: { id: row.registeredWorkItemId },
      select: { id: true, sourceSystem: true, sourceKey: true,
        v4SourceApprovalId: true, status: true },
    }) : Promise.resolve(null),
    row.resolvedNodeId ? prisma.amuxPortfolioNodeRevision.findFirst({
      where: { nodeId: row.resolvedNodeId, decisionId: row.id },
      select: { nodeId: true, revision: true, contentDigest: true,
        contentDigestKeyId: true, authorizationAuditLogId: true },
    }) : Promise.resolve(null),
    row.resolvedNodeId ? prisma.amuxPortfolioNode.findUnique({
      where: { id: row.resolvedNodeId },
      select: { id: true, revision: true, contentDigest: true,
        contentDigestKeyId: true, authorizationAuditLogId: true },
    }) : Promise.resolve(null),
    row.state === "consumed" && ["reject_unit", "select_existing_node",
      "link_existing_node", "link_existing_card"].includes(row.action) ?
      prisma.amuxIdeaDraftUnit.findUnique({ where: { id: row.draftUnitId },
        select: { state: true, ideaId: true, actorUserId: true } }) :
      Promise.resolve(null),
    row.linkedNodeId ? prisma.amuxPortfolioNode.findUnique({
      where: { id: row.linkedNodeId },
      select: { id: true, level: true, parentId: true },
    }) : Promise.resolve(null),
    row.linkedNodeId && row.baseNodeRevision !== null ?
      prisma.amuxPortfolioNodeRevision.findUnique({ where: {
        nodeId_revision: { nodeId: row.linkedNodeId,
          revision: row.baseNodeRevision },
      }, select: { decisionId: true, contentDigest: true,
        contentDigestKeyId: true } }) : Promise.resolve(null),
    row.linkedWorkItemId ? prisma.amuxWorkItem.findUnique({
      where: { id: row.linkedWorkItemId },
      select: { id: true, sourceSystem: true,
        v4SourceApprovalId: true },
    }) : Promise.resolve(null),
    row.outcomeUnknownAuditLogId ? prisma.adminAuditLog.findUnique({
      where: { id: row.outcomeUnknownAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true, metadata: true },
    }) : Promise.resolve(null),
    row.outcomeUnknownResolvedAuditLogId ? prisma.adminAuditLog.findUnique({
      where: { id: row.outcomeUnknownResolvedAuditLogId },
      select: { action: true, actorUserId: true, targetType: true,
        targetId: true, entryHash: true },
    }) : Promise.resolve(null),
  ]);
  if (!["register_card", "create_node", "reject_unit",
      "select_existing_node", "link_existing_node",
      "link_existing_card"].includes(row.action) ||
      !prepareAudit?.entryHash || prepareAudit.action !== "amux.v4.unit.prepare" ||
      prepareAudit.actorUserId !== actorUserId ||
      prepareAudit.targetType !== "AmuxIdeaUnitDecision" ||
      prepareAudit.targetId !== row.id ||
      (row.outcomeUnknownAt !== null && (!unknownAudit?.entryHash ||
        unknownAudit.action !== "amux.v4.unit.outcome_unknown" ||
        unknownAudit.actorUserId !== null ||
        unknownAudit.targetType !== "AmuxIdeaUnitDecision" ||
        unknownAudit.targetId !== row.id ||
        typeof unknownAudit.metadata !== "object" ||
        unknownAudit.metadata === null ||
        (unknownAudit.metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY] !==
          AMUX_V4_IDEA_SYSTEM_ACTOR)) ||
      (row.outcomeUnknownResolvedAt !== null &&
        (!unknownResolvedAudit?.entryHash ||
        unknownResolvedAudit.action !== "amux.v4.unit.no_commit_confirmed" ||
        unknownResolvedAudit.actorUserId !== actorUserId ||
        unknownResolvedAudit.targetType !== "AmuxIdeaUnitDecision" ||
        unknownResolvedAudit.targetId !== row.id)) ||
      (row.finalAuditLogId !== null && (!finalAudit?.entryHash ||
        finalAudit.action !== ({ consumed: "amux.v4.unit.consume",
          cancelled: "amux.v4.unit.cancel", invalidated: "amux.v4.unit.invalidate",
          expired: "amux.v4.unit.expire" } as Record<string, string>)[row.state] ||
        finalAudit.targetType !== "AmuxIdeaUnitDecision" ||
        (["expired", "invalidated"].includes(row.state) ?
          (finalAudit.actorUserId !== null ||
            typeof finalAudit.metadata !== "object" ||
            finalAudit.metadata === null ||
            (finalAudit.metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY] !==
              AMUX_V4_IDEA_SYSTEM_ACTOR) :
          finalAudit.actorUserId !== actorUserId) ||
        finalAudit.targetId !== row.id)) ||
      (row.state === "consumed" && row.action === "register_card" && (!card ||
        card.sourceSystem !== "admin-idea-v4" ||
        card.sourceKey !== row.draftUnitId.toUpperCase() ||
        card.v4SourceApprovalId !== row.id)) ||
      (row.state === "consumed" && row.action === "create_node" &&
        (!nodeRevision || !node || node.id !== row.resolvedNodeId ||
          nodeRevision.nodeId !== node.id || nodeRevision.revision !== 0 ||
          nodeRevision.contentDigest !== node.contentDigest ||
          nodeRevision.contentDigestKeyId !== node.contentDigestKeyId ||
          nodeRevision.authorizationAuditLogId !== row.finalAuditLogId ||
          node.authorizationAuditLogId !== row.finalAuditLogId)) ||
      (row.state === "consumed" && row.action === "reject_unit" &&
        (!decisionDraft || decisionDraft.state !== "rejected" ||
          decisionDraft.ideaId !== row.ideaId ||
          decisionDraft.actorUserId !== actorUserId ||
          row.registeredWorkItemId !== null || row.resolvedNodeId !== null)) ||
      (row.state === "consumed" &&
        ["select_existing_node", "link_existing_node"].includes(row.action) &&
        (!linkedNode || !linkedRevision || !decisionDraft ||
          decisionDraft.state !== "approved" ||
          decisionDraft.ideaId !== row.ideaId ||
          decisionDraft.actorUserId !== actorUserId ||
          linkedNode.id !== row.baseNodeId ||
          linkedRevision.contentDigest !== row.baseNodeDigest ||
          linkedRevision.contentDigestKeyId !== row.baseNodeDigestKeyId ||
          row.registeredWorkItemId !== null || row.resolvedNodeId !== null)) ||
      (row.state === "consumed" && row.action === "link_existing_card" &&
        (!decisionDraft || decisionDraft.state !== "approved" ||
          decisionDraft.ideaId !== row.ideaId ||
          decisionDraft.actorUserId !== actorUserId ||
          !linkedCard || linkedCard.id !== row.baseWorkItemId ||
          linkedCard.sourceSystem !== "admin-idea-v4" ||
          !linkedCard.v4SourceApprovalId ||
          row.registeredWorkItemId !== null || row.resolvedNodeId !== null))) {
    return { state: "integrity_unavailable", retryWrite: false } as const;
  }
  if (row.outcomeUnknownAt !== null &&
      row.outcomeUnknownResolvedAt === null) {
    return { state: "outcome_unknown", retryWrite: false,
      decisionId: row.id, ideaId: row.ideaId,
      draftUnitId: row.draftUnitId,
      consumeRequestId: row.outcomeUnknownConsumeRequestId } as const;
  }
  if (row.state === "consumed" && card) {
    return { state: "consumed", retryWrite: false, decisionId: row.id,
      ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      cardId: card.id, cardStatus: card.status } as const;
  }
  if (row.state === "consumed" && nodeRevision) {
    return { state: "consumed", retryWrite: false, decisionId: row.id,
      ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      nodeId: nodeRevision.nodeId } as const;
  }
  if (row.state === "consumed" && row.action === "reject_unit") {
    return { state: "consumed", action: "reject_unit", retryWrite: false,
      decisionId: row.id, ideaId: row.ideaId,
      draftUnitId: row.draftUnitId } as const;
  }
  if (row.state === "consumed" && linkedNode) {
    return { state: "consumed", action: row.action,
      retryWrite: false, decisionId: row.id,
      ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      nodeId: linkedNode.id, targetCreated: false } as const;
  }
  if (row.state === "consumed" && linkedCard) {
    return { state: "consumed", action: "link_existing_card",
      retryWrite: false, decisionId: row.id,
      ideaId: row.ideaId, draftUnitId: row.draftUnitId,
      cardId: linkedCard.id, targetCreated: false } as const;
  }
  if (row.state !== "prepared") {
    return { state: row.state, retryWrite: false, decisionId: row.id,
      ideaId: row.ideaId, draftUnitId: row.draftUnitId } as const;
  }
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date)) {
    return { state: "integrity_unavailable", retryWrite: false } as const;
  }
  return { state: now >= row.expiresAt ? "expired" : "prepared",
    retryWrite: false, decisionId: row.id,
    ideaId: row.ideaId, draftUnitId: row.draftUnitId,
    confirmationDigest: row.confirmationDigest,
    expiresAt: row.expiresAt.toISOString() } as const;
}

/** A lost consume response must freeze the exact receipt before it can be
 * offered to another request. The original transaction and this observation
 * serialize on the decision row; a committed consume is never overwritten. */
export async function markAmuxV4UnitConsumeOutcomeUnknown(input: {
  session: Session; decisionId: string; consumeRequestId: string;
}): Promise<"recorded" | "already_unknown" | "committed" | "unavailable"> {
  const actorUserId = ownerId(input.session);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.decisionId) ||
      !/^[a-f0-9-]{36}$/.test(input.consumeRequestId)) return "unavailable";
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await takeAuditChainLock(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxIdeaUnitDecision"
        WHERE "id" = ${input.decisionId} AND "actorUserId" = ${actorUserId}
        FOR UPDATE
      `;
      if (rows.length !== 1) return "unavailable" as const;
      const row = await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: input.decisionId },
        select: { state: true, consumeRequestId: true,
          outcomeUnknownAt: true },
      });
      if (row?.state === "consumed" &&
          row.consumeRequestId === input.consumeRequestId) {
        return "committed" as const;
      }
      if (row?.state !== "prepared") return "unavailable" as const;
      if (row.outcomeUnknownAt !== null) return "already_unknown" as const;
      const audit = await writeAmuxV4UnitHousekeepingAudit({ tx,
        action: "amux.v4.unit.outcome_unknown",
        targetType: "AmuxIdeaUnitDecision", targetId: input.decisionId,
        summary: "Recorded an uncertain AMUX v4 unit consume outcome.",
        metadata: { consumeRequestId: input.consumeRequestId },
      });
      const updated = await tx.amuxIdeaUnitDecision.updateMany({
        where: { id: input.decisionId, actorUserId, state: "prepared",
          outcomeUnknownAt: null },
        data: { outcomeUnknownAt: new Date(),
          outcomeUnknownConsumeRequestId: input.consumeRequestId,
          outcomeUnknownAuditLogId: audit.id },
      });
      if (updated.count !== 1) throw new Error("unknown marker lost its lock");
      return "recorded" as const;
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
  } catch {
    // A serializable loser may fail after the other marker committed. This is
    // read-only reconciliation of the exact request, never a blind retry.
    try {
      const observed = await readAmuxV4UnitDecision(input.session,
        { decisionId: input.decisionId });
      if (observed.state === "outcome_unknown" &&
          observed.consumeRequestId === input.consumeRequestId) {
        return "already_unknown";
      }
      if (observed.state === "consumed" &&
          await prisma.amuxIdeaUnitDecision.findFirst({
            where: { id: input.decisionId, actorUserId,
              state: "consumed", consumeRequestId: input.consumeRequestId },
            select: { id: true },
          })) return "committed";
    } catch { /* Keep the decision unavailable if readback fails. */ }
    return "unavailable";
  }
}

/** The owner may close only an observed, still-prepared unknown receipt.
 * Resolution and invalidation are separate guarded transitions in one tx;
 * neither transition permits reusing this 15-minute confirmation. */
export async function confirmAmuxV4UnitNoCommit(input: {
  session: Session; request: Request; decisionId: string;
  consumeRequestId: string; confirmation: "no_commit";
}) {
  const actorUserId = ownerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.decisionId) ||
      !/^[a-f0-9-]{36}$/.test(input.consumeRequestId) ||
      input.confirmation !== "no_commit") {
    throw new AmuxV4UnitDecisionError("not_ready");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await takeAuditChainLock(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxIdeaUnitDecision"
        WHERE "id" = ${input.decisionId} AND "actorUserId" = ${actorUserId}
        FOR UPDATE
      `;
      if (rows.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
      const row = await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: input.decisionId },
        select: { id: true, ideaId: true, draftUnitId: true,
          state: true, outcomeUnknownAt: true,
          outcomeUnknownConsumeRequestId: true,
          outcomeUnknownResolvedAt: true, finalAuditLogId: true },
      });
      if (!row || row.state !== "prepared" ||
          row.outcomeUnknownAt === null ||
          row.outcomeUnknownResolvedAt !== null ||
          row.finalAuditLogId !== null ||
          row.outcomeUnknownConsumeRequestId !== input.consumeRequestId) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const appliedCard = await tx.amuxWorkItem.findFirst({
        where: { v4SourceApprovalId: row.id }, select: { id: true },
      });
      const appliedNode = await tx.amuxPortfolioNodeRevision.findFirst({
        where: { decisionId: row.id }, select: { id: true },
      });
      if (appliedCard || appliedNode) {
        throw new AmuxV4UnitDecisionError("integrity_unavailable");
      }
      const humanAuditId = await writeAdminAuditLog({ tx,
        session: input.session, request: input.request,
        action: "amux.v4.unit.no_commit_confirmed",
        targetType: "AmuxIdeaUnitDecision", targetId: row.id,
        summary: "Owner confirmed no AMUX v4 unit consume committed.",
        metadata: { ideaId: row.ideaId, draftUnitId: row.draftUnitId,
          consumeRequestId: input.consumeRequestId },
      });
      await tx.amuxIdeaUnitDecision.update({ where: { id: row.id },
        data: { outcomeUnknownResolvedAt: new Date(),
          outcomeUnknownResolution: "no_commit",
          outcomeUnknownResolvedAuditLogId: humanAuditId },
      });
      const systemAudit = await writeAmuxV4UnitHousekeepingAudit({ tx,
        action: "amux.v4.unit.invalidate",
        targetType: "AmuxIdeaUnitDecision", targetId: row.id,
        summary: "Invalidated a confirmed uncommitted AMUX v4 receipt.",
        metadata: { consumeRequestId: input.consumeRequestId },
      });
      await tx.amuxIdeaUnitDecision.update({ where: { id: row.id },
        data: { state: "invalidated", finalAuditLogId: systemAudit.id },
      });
      callbackReturned = true;
      return { state: "invalidated" as const, decisionId: row.id,
        auditId: humanAuditId, retryWrite: false as const };
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}

/** Explicit owner cancellation of an unconsumed preparation. This never
 * removes an applied card and cannot resolve an uncertain consume outcome. */
export async function cancelAmuxV4UnitDecision(input: {
  session: Session; request: Request; decisionId: string;
}) {
  const actorUserId = ownerId(input.session);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.decisionId)) {
    throw new AmuxV4UnitDecisionError("not_found");
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await takeAuditChainLock(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxIdeaUnitDecision"
        WHERE "id" = ${input.decisionId} AND "actorUserId" = ${actorUserId}
        FOR UPDATE
      `;
      if (rows.length !== 1) throw new AmuxV4UnitDecisionError("not_found");
      const decision = await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: input.decisionId },
        select: { id: true, state: true, action: true, ideaId: true,
          draftUnitId: true, outcomeUnknownAt: true },
      });
      if (!decision || decision.state !== "prepared" ||
      !["register_card", "create_node", "reject_unit",
        "select_existing_node", "link_existing_node",
        "link_existing_card"].includes(decision.action) ||
          decision.outcomeUnknownAt !== null) {
        throw new AmuxV4UnitDecisionError("reconfirm");
      }
      const auditId = await writeAdminAuditLog({ tx, session: input.session,
        request: input.request, action: "amux.v4.unit.cancel",
        targetType: "AmuxIdeaUnitDecision", targetId: decision.id,
        summary: "Cancelled one unconsumed AMUX v4 unit confirmation.",
        metadata: { ideaId: decision.ideaId,
          draftUnitId: decision.draftUnitId, action: decision.action },
      });
      const updated = await tx.amuxIdeaUnitDecision.updateMany({
        where: { id: decision.id, actorUserId, state: "prepared",
          outcomeUnknownAt: null },
        data: { state: "cancelled", finalAuditLogId: auditId },
      });
      if (updated.count !== 1) throw new AmuxV4UnitDecisionError("reconfirm");
      callbackReturned = true;
      return { state: "cancelled" as const, decisionId: decision.id,
        auditId, retryWrite: false as const };
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxV4UnitDecisionError) throw error;
    throw new AmuxV4UnitDecisionError("outcome_unknown");
  }
}
