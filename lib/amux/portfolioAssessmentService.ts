import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { amuxPortfolioAssessmentPayloadSchema,
  parseAmuxPortfolioMetrics, type AmuxPortfolioAssessmentPayload } from
  "./portfolioScoreSchemas.ts";

export const AMUX_V4_PORTFOLIO_WRITE_CODE_ENABLED = true;
export const AMUX_V4_PORTFOLIO_WRITE_ENV = "TOMVERSE_AMUX_V4_PORTFOLIO_WRITE";
export const amuxV4PortfolioWriteEnabled = (value: string | undefined) =>
  AMUX_V4_PORTFOLIO_WRITE_CODE_ENABLED && value === "enabled";

export class AmuxPortfolioError extends Error {
  constructor(readonly code: "forbidden" | "invalid_input" | "not_found" |
    "not_ready" | "reconfirm" | "write_disabled" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxPortfolioError";
  }
}

export const amuxPortfolioOwnerId = (session: Session): string => {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxPortfolioError("forbidden");
  }
  return id;
};

type AssessmentPlan = {
  subjectRevision: number; subjectDigest: string; subjectDigestKeyId: string;
  assessmentVersion: number; priorAssessmentId: string | null;
  metrics: Record<string, number>; evidenceAsOf: Date;
  confirmationDigest: string; confirmationDigestKeyId: string;
  priorMetrics: Prisma.JsonValue | null;
};

async function buildAssessmentPlan(tx: Prisma.TransactionClient,
  actorUserId: string, payload: AmuxPortfolioAssessmentPayload,
  digestKey: AmuxDigestKey): Promise<AssessmentPlan> {
  const parsed = amuxPortfolioAssessmentPayloadSchema.safeParse(payload);
  if (!parsed.success ||
      new Set(payload.evidenceRefs).size !== payload.evidenceRefs.length) {
    throw new AmuxPortfolioError("invalid_input");
  }
  let metrics: Record<string, number>;
  try { metrics = parseAmuxPortfolioMetrics(payload.subject.kind, payload.metrics); }
  catch { throw new AmuxPortfolioError("invalid_input"); }
  let subjectRevision: number; let subjectDigest: string;
  let subjectDigestKeyId: string;
  let sourceDecisionId: string | null = null;
  const { id, kind } = payload.subject;
  if (["initiative", "epic", "feature"].includes(kind)) {
    const node = await tx.amuxPortfolioNode.findUnique({ where: { id },
      select: { level: true, state: true, revision: true,
        contentDigest: true, contentDigestKeyId: true } });
    if (!node || node.level !== kind || node.state !== "active") {
      throw new AmuxPortfolioError("not_ready");
    }
    subjectRevision = node.revision;
    subjectDigest = node.contentDigest;
    subjectDigestKeyId = node.contentDigestKeyId;
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: id, revision: node.revision } },
      select: { decisionId: true },
    });
    sourceDecisionId = revision?.decisionId ?? null;
  } else {
    const card = await tx.amuxWorkItem.findUnique({ where: { id },
      select: { cardType: true, sourceSystem: true, status: true,
        revision: true, v4BodyDigest: true, v4BodyDigestKeyId: true,
        v4SourceApprovalId: true } });
    const decision = card?.v4SourceApprovalId ?
      await tx.amuxIdeaUnitDecision.findUnique({ where: {
        id: card.v4SourceApprovalId,
      }, select: { state: true, action: true, registeredWorkItemId: true } }) : null;
    if (!card || card.sourceSystem !== "admin-idea-v4" ||
        card.cardType !== kind || ["done", "cancelled"].includes(card.status) ||
        !card.v4BodyDigest || !card.v4BodyDigestKeyId ||
        decision?.state !== "consumed" || decision.action !== "register_card" ||
        decision.registeredWorkItemId !== id) {
      throw new AmuxPortfolioError("not_ready");
    }
    subjectRevision = card.revision;
    subjectDigest = card.v4BodyDigest;
    subjectDigestKeyId = card.v4BodyDigestKeyId;
    sourceDecisionId = card.v4SourceApprovalId;
  }
  if (payload.modelProposalDigest !== null) {
    const decision = sourceDecisionId ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: sourceDecisionId },
      select: { state: true, draftUnitId: true },
    }) : null;
    const unit = decision?.state === "consumed" ?
      await tx.amuxIdeaDraftUnit.findUnique({ where: {
        id: decision.draftUnitId },
        select: { state: true, bodyDigest: true },
      }) : null;
    if (unit?.state !== "approved" ||
        unit.bodyDigest !== payload.modelProposalDigest) {
      throw new AmuxPortfolioError("reconfirm");
    }
  }
  const prior = await tx.amuxPortfolioAssessment.findFirst({ where:
    kind === "story" || kind === "task" ? { cardId: id } : { nodeId: id },
    orderBy: { assessmentVersion: "desc" },
    select: { id: true, assessmentVersion: true, metrics: true } });
  if ((!prior && payload.reasonCode !== "initial") ||
      (prior && payload.reasonCode === "initial")) {
    throw new AmuxPortfolioError("reconfirm");
  }
  const evidenceAsOf = new Date(payload.evidenceAsOf);
  if (!Number.isFinite(evidenceAsOf.getTime()) ||
      evidenceAsOf.getTime() > Date.now() ||
      Buffer.byteLength(amuxCanonicalJson(payload), "utf8") > 8_192) {
    throw new AmuxPortfolioError("invalid_input");
  }
  const assessmentVersion = (prior?.assessmentVersion ?? 0) + 1;
  const canonical = Buffer.from(amuxCanonicalJson({
    schemaVersion: 1, actorUserId, id: payload.id, requestId: payload.requestId,
    subject: payload.subject, subjectRevision, subjectDigest,
    subjectDigestKeyId, assessmentVersion, priorAssessmentId: prior?.id ?? null,
    metrics, uncertainty: payload.uncertainty,
    evidenceRefs: [...payload.evidenceRefs].sort(),
    evidenceAsOf: evidenceAsOf.toISOString(), reasonCode: payload.reasonCode,
    modelProposalDigest: payload.modelProposalDigest,
  }), "utf8");
  try {
    const digest = amuxContentDigest(canonical, "portfolio_assessment",
      payload.id, digestKey);
    return { subjectRevision, subjectDigest, subjectDigestKeyId,
      assessmentVersion, priorAssessmentId: prior?.id ?? null,
      metrics, evidenceAsOf, confirmationDigest: digest.digest,
      confirmationDigestKeyId: digest.digestKeyId,
      priorMetrics: prior?.metrics ?? null };
  } finally { canonical.fill(0); }
}

export async function previewAmuxPortfolioAssessment(session: Session,
  payload: AmuxPortfolioAssessmentPayload, digestKey: AmuxDigestKey) {
  const actorUserId = amuxPortfolioOwnerId(session);
  return prisma.$transaction(async (tx) =>
    buildAssessmentPlan(tx, actorUserId, payload, digestKey),
  { isolationLevel: "RepeatableRead", maxWait: 2_000, timeout: 8_000 });
}

/** Direct writer is for synthetic DB tests; the public route uses the latch. */
export async function commitAmuxPortfolioAssessment(input: {
  session: Session; request: Request; payload: AmuxPortfolioAssessmentPayload;
  confirmationDigest: string; digestKey: AmuxDigestKey;
}) {
  const actorUserId = amuxPortfolioOwnerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    await takeAuditChainLock(tx);
    const target = input.payload.subject;
    const locked = target.kind === "story" || target.kind === "task"
      ? await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${target.id} FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxPortfolioNode" WHERE "id" = ${target.id} FOR UPDATE`;
    if (locked.length !== 1) throw new AmuxPortfolioError("not_found");
    if (await tx.amuxPortfolioAssessment.findUnique({ where: {
      requestId: input.payload.requestId,
    }, select: { id: true } })) {
      throw new AmuxPortfolioError("reconfirm");
    }
    const plan = await buildAssessmentPlan(tx, actorUserId,
      input.payload, input.digestKey);
    if (plan.confirmationDigest !== input.confirmationDigest) {
      throw new AmuxPortfolioError("reconfirm");
    }
    const auditId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: "amux.v4.portfolio.assessment.approve",
      targetType: "AmuxPortfolioAssessment", targetId: input.payload.id,
      summary: "Confirmed one versioned portfolio evidence assessment.",
      metadata: { subjectKind: target.kind, subjectId: target.id,
        assessmentVersion: plan.assessmentVersion,
        confirmationDigest: plan.confirmationDigest,
        reasonCode: input.payload.reasonCode,
        priorMetrics: plan.priorMetrics, nextMetrics: plan.metrics,
        evidenceRefCount: input.payload.evidenceRefs.length,
        evidenceAsOf: plan.evidenceAsOf.toISOString() },
    });
    const now = new Date();
    await tx.amuxPortfolioAssessment.create({ data: {
      id: input.payload.id, requestId: input.payload.requestId,
      nodeId: target.kind === "story" || target.kind === "task" ? null : target.id,
      cardId: target.kind === "story" || target.kind === "task" ? target.id : null,
      subjectKind: target.kind, subjectRevision: plan.subjectRevision,
      subjectDigest: plan.subjectDigest,
      subjectDigestKeyId: plan.subjectDigestKeyId,
      assessmentVersion: plan.assessmentVersion,
      metrics: plan.metrics, uncertainty: input.payload.uncertainty,
      evidenceRefs: [...input.payload.evidenceRefs].sort(),
      evidenceAsOf: plan.evidenceAsOf,
      reasonCode: input.payload.reasonCode,
      modelProposalDigest: input.payload.modelProposalDigest,
      confirmationDigest: plan.confirmationDigest,
      confirmationDigestKeyId: plan.confirmationDigestKeyId,
      priorAssessmentId: plan.priorAssessmentId,
      approvedByUserId: actorUserId, approvalAuditLogId: auditId,
      approvedAt: now,
    } });
    return { state: "approved" as const, assessmentId: input.payload.id,
      assessmentVersion: plan.assessmentVersion, auditId };
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
}

export async function approveAmuxPortfolioAssessment(
  input: Parameters<typeof commitAmuxPortfolioAssessment>[0]) {
  if (!amuxV4PortfolioWriteEnabled(process.env[AMUX_V4_PORTFOLIO_WRITE_ENV])) {
    throw new AmuxPortfolioError("write_disabled");
  }
  return commitAmuxPortfolioAssessment(input);
}

export async function readAmuxPortfolioAssessment(session: Session,
  requestId: string) {
  const actorUserId = amuxPortfolioOwnerId(session);
  if (!/^[a-f0-9-]{36}$/.test(requestId)) {
    throw new AmuxPortfolioError("not_found");
  }
  const row = await prisma.amuxPortfolioAssessment.findFirst({ where: {
    requestId, approvedByUserId: actorUserId,
  }, select: { id: true, subjectKind: true, nodeId: true, cardId: true,
    assessmentVersion: true, confirmationDigest: true,
    approvalAuditLogId: true } });
  if (!row) return { state: "not_found" as const };
  const audit = await prisma.adminAuditLog.findUnique({ where: {
    id: row.approvalAuditLogId,
  }, select: { action: true, targetId: true, actorUserId: true,
    entryHash: true } });
  if (!audit?.entryHash || audit.action !==
      "amux.v4.portfolio.assessment.approve" ||
      audit.targetId !== row.id || audit.actorUserId !== actorUserId) {
    throw new AmuxPortfolioError("integrity_unavailable");
  }
  return { state: "approved" as const, assessmentId: row.id,
    subjectKind: row.subjectKind, subjectId: row.nodeId ?? row.cardId,
    assessmentVersion: row.assessmentVersion,
    confirmationDigest: row.confirmationDigest };
}
