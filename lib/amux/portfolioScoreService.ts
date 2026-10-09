import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxPortfolioOwnerId, AmuxPortfolioError,
  amuxV4PortfolioWriteEnabled, AMUX_V4_PORTFOLIO_WRITE_ENV } from
  "./portfolioAssessmentService.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { scoreAmuxPortfolio } from "./portfolioScoreCore.ts";
import type { AmuxPortfolioScorePayload } from "./portfolioScoreSchemas.ts";

type Assessment = Prisma.AmuxPortfolioAssessmentGetPayload<{
  select: { id: true; nodeId: true; cardId: true; subjectRevision: true;
    subjectDigest: true; subjectDigestKeyId: true; metrics: true;
    uncertainty: true; evidenceAsOf: true; confirmationDigest: true;
    assessmentVersion: true; }
}>;

const assessmentSelect = {
  id: true, nodeId: true, cardId: true, subjectRevision: true,
  subjectDigest: true, subjectDigestKeyId: true, metrics: true,
  uncertainty: true, evidenceAsOf: true, confirmationDigest: true,
  assessmentVersion: true,
} as const;

async function latestAssessment(tx: Prisma.TransactionClient,
  subject: { nodeId?: string; cardId?: string }, revision: number,
  digest: string, keyId: string): Promise<Assessment> {
  const row = await tx.amuxPortfolioAssessment.findFirst({
    where: subject, orderBy: { assessmentVersion: "desc" },
    select: assessmentSelect,
  });
  if (!row || row.subjectRevision !== revision ||
      row.subjectDigest !== digest || row.subjectDigestKeyId !== keyId) {
    throw new AmuxPortfolioError("not_ready");
  }
  return row;
}

const metric = (assessment: Assessment, key: string): 0 | 1 | 2 | 3 | 4 | 5 => {
  const value = (assessment.metrics as Record<string, unknown>)[key];
  if (!Number.isInteger(value) || typeof value !== "number" ||
      value < 0 || value > 5) throw new AmuxPortfolioError("integrity_unavailable");
  return value as 0 | 1 | 2 | 3 | 4 | 5;
};

async function buildScorePlan(tx: Prisma.TransactionClient, actorUserId: string,
  payload: AmuxPortfolioScorePayload, digestKey: AmuxDigestKey) {
  const task = await tx.amuxWorkItem.findUnique({ where: { id: payload.taskId },
    select: { id: true, cardType: true, status: true, sourceSystem: true,
      revision: true, v4BodyDigest: true, v4BodyDigestKeyId: true,
      v4SourceApprovalId: true, parentFeatureNodeId: true,
      parentStoryCardId: true } });
  if (!task || task.cardType !== "task" ||
      task.sourceSystem !== "admin-idea-v4" ||
      ["done", "cancelled"].includes(task.status) ||
      !task.parentFeatureNodeId || !task.v4BodyDigest ||
      !task.v4BodyDigestKeyId || !task.v4SourceApprovalId) {
    throw new AmuxPortfolioError("not_ready");
  }
  const sourceDecision = await tx.amuxIdeaUnitDecision.findUnique({
    where: { id: task.v4SourceApprovalId },
    select: { state: true, action: true, registeredWorkItemId: true },
  });
  if (sourceDecision?.state !== "consumed" ||
      sourceDecision.action !== "register_card" ||
      sourceDecision.registeredWorkItemId !== task.id) {
    throw new AmuxPortfolioError("not_ready");
  }
  const feature = await tx.amuxPortfolioNode.findUnique({
    where: { id: task.parentFeatureNodeId },
    select: { id: true, level: true, state: true, parentId: true,
      revision: true, contentDigest: true, contentDigestKeyId: true },
  });
  const epic = feature?.parentId ? await tx.amuxPortfolioNode.findUnique({
    where: { id: feature.parentId },
    select: { id: true, level: true, state: true, parentId: true,
      revision: true, contentDigest: true, contentDigestKeyId: true },
  }) : null;
  const initiative = epic?.parentId ? await tx.amuxPortfolioNode.findUnique({
    where: { id: epic.parentId },
    select: { id: true, level: true, state: true, parentId: true,
      revision: true, contentDigest: true, contentDigestKeyId: true },
  }) : null;
  if (!feature || feature.level !== "feature" || feature.state !== "active" ||
      !epic || epic.level !== "epic" || epic.state !== "active" ||
      !initiative || initiative.level !== "initiative" ||
      initiative.state !== "active" || initiative.parentId !== null) {
    throw new AmuxPortfolioError("not_ready");
  }
  const story = task.parentStoryCardId ? await tx.amuxWorkItem.findUnique({
    where: { id: task.parentStoryCardId },
    select: { id: true, cardType: true, status: true,
      sourceSystem: true, parentFeatureNodeId: true, revision: true,
      v4BodyDigest: true, v4BodyDigestKeyId: true },
  }) : null;
  if (task.parentStoryCardId && (!story || story.cardType !== "story" ||
      story.sourceSystem !== "admin-idea-v4" ||
      story.parentFeatureNodeId !== feature.id ||
      ["done", "cancelled"].includes(story.status) ||
      !story.v4BodyDigest || !story.v4BodyDigestKeyId)) {
    throw new AmuxPortfolioError("not_ready");
  }
  const [ia, ea, fa, sa, ta] = await Promise.all([
    latestAssessment(tx, { nodeId: initiative.id }, initiative.revision,
      initiative.contentDigest, initiative.contentDigestKeyId),
    latestAssessment(tx, { nodeId: epic.id }, epic.revision,
      epic.contentDigest, epic.contentDigestKeyId),
    latestAssessment(tx, { nodeId: feature.id }, feature.revision,
      feature.contentDigest, feature.contentDigestKeyId),
    story ? latestAssessment(tx, { cardId: story.id }, story.revision,
      story.v4BodyDigest!, story.v4BodyDigestKeyId!) : Promise.resolve(null),
    latestAssessment(tx, { cardId: task.id }, task.revision,
      task.v4BodyDigest, task.v4BodyDigestKeyId),
  ]);
  const assessments = [ia, ea, fa, ...(sa ? [sa] : []), ta];
  const evidenceAsOf = new Date(Math.min(...assessments.map(
    (item) => item.evidenceAsOf.getTime())));
  const uncertainty = assessments.some((item) => item.uncertainty === "high") ?
    "high" : assessments.some((item) => item.uncertainty === "medium") ?
      "medium" : "low";
  const score = scoreAmuxPortfolio({
    initiativeValue: metric(ia, "value"), epicValue: metric(ea, "value"),
    featureValue: metric(fa, "value"), storyImpact: sa ? metric(sa, "impact") : null,
    taskContribution: metric(ta, "contribution"),
    urgency: metric(ta, "urgency"),
    dependencyUnlock: metric(ta, "dependencyUnlock"),
    workerCoverage: metric(ta, "workerCoverage"),
    effort: metric(ta, "effort"), deliveryRisk: metric(ta, "deliveryRisk"),
    uncertainty, evidenceConfirmedAt: evidenceAsOf,
  }, new Date());
  const binding = {
    schemaVersion: 1, actorUserId, id: payload.id,
    requestId: payload.requestId, taskId: task.id,
    taskRevision: task.revision, sourceApprovalId: task.v4SourceApprovalId,
    path: { initiativeId: initiative.id, epicId: epic.id,
      featureId: feature.id, storyId: story?.id ?? null },
    assessments: assessments.map((item) => ({ id: item.id,
      version: item.assessmentVersion, digest: item.confirmationDigest })),
    scoreVersion: score.version, total: score.total,
    components: score.components, evidenceAsOf: score.evidenceConfirmedAt,
  };
  const canonical = Buffer.from(amuxCanonicalJson(binding), "utf8");
  try {
    const digest = amuxContentDigest(canonical, "portfolio_score",
      payload.id, digestKey);
    return { taskRevision: task.revision,
      sourceApprovalId: task.v4SourceApprovalId,
      initiativeAssessmentId: ia.id, epicAssessmentId: ea.id,
      featureAssessmentId: fa.id, storyAssessmentId: sa?.id ?? null,
      taskAssessmentId: ta.id, score,
      inputDigest: digest.digest, inputDigestKeyId: digest.digestKeyId };
  } finally { canonical.fill(0); }
}

export async function previewAmuxPortfolioScore(session: Session,
  payload: AmuxPortfolioScorePayload, digestKey: AmuxDigestKey) {
  const actorUserId = amuxPortfolioOwnerId(session);
  return prisma.$transaction(async (tx) =>
    buildScorePlan(tx, actorUserId, payload, digestKey),
  { isolationLevel: "RepeatableRead", maxWait: 2_000, timeout: 8_000 });
}

/** Direct writer is for synthetic DB tests; the route uses the code latch. */
export async function commitAmuxPortfolioScore(input: { session: Session;
  request: Request; payload: AmuxPortfolioScorePayload;
  confirmationDigest: string; digestKey: AmuxDigestKey }) {
  const actorUserId = amuxPortfolioOwnerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    await takeAuditChainLock(tx);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${input.payload.taskId}
      FOR UPDATE`;
    if (locked.length !== 1) throw new AmuxPortfolioError("not_found");
    if (await tx.amuxPortfolioScoreSnapshot.findUnique({ where: {
      requestId: input.payload.requestId }, select: { id: true } })) {
      throw new AmuxPortfolioError("reconfirm");
    }
    const plan = await buildScorePlan(tx, actorUserId,
      input.payload, input.digestKey);
    if (plan.inputDigest !== input.confirmationDigest) {
      throw new AmuxPortfolioError("reconfirm");
    }
    const auditId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: "amux.v4.portfolio.score.confirm",
      targetType: "AmuxPortfolioScoreSnapshot", targetId: input.payload.id,
      summary: "Confirmed a deterministic portfolio score snapshot.",
      metadata: { taskId: input.payload.taskId,
        scoreVersion: plan.score.version, scoreTotal: plan.score.total,
        inputDigest: plan.inputDigest,
        evidenceAsOf: plan.score.evidenceConfirmedAt },
    });
    await tx.amuxPortfolioScoreSnapshot.create({ data: {
      id: input.payload.id, requestId: input.payload.requestId,
      taskId: input.payload.taskId, taskRevision: plan.taskRevision,
      sourceApprovalId: plan.sourceApprovalId,
      initiativeAssessmentId: plan.initiativeAssessmentId,
      epicAssessmentId: plan.epicAssessmentId,
      featureAssessmentId: plan.featureAssessmentId,
      storyAssessmentId: plan.storyAssessmentId,
      taskAssessmentId: plan.taskAssessmentId,
      scoreVersion: plan.score.version, scoreTotal: plan.score.total,
      components: plan.score.components, inputDigest: plan.inputDigest,
      inputDigestKeyId: plan.inputDigestKeyId,
      evidenceAsOf: new Date(plan.score.evidenceConfirmedAt),
      activeStaleAt: new Date(plan.score.activeStaleAt),
      baselineStaleAt: new Date(plan.score.baselineStaleAt),
      approvedByUserId: actorUserId, approvalAuditLogId: auditId,
      computedAt: new Date(),
    } });
    return { state: "confirmed" as const, scoreId: input.payload.id,
      score: plan.score, auditId };
  }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 15_000 });
}

export async function confirmAmuxPortfolioScore(
  input: Parameters<typeof commitAmuxPortfolioScore>[0]) {
  if (!amuxV4PortfolioWriteEnabled(process.env[AMUX_V4_PORTFOLIO_WRITE_ENV])) {
    throw new AmuxPortfolioError("write_disabled");
  }
  return commitAmuxPortfolioScore(input);
}

export async function readAmuxPortfolioScore(session: Session, requestId: string) {
  const actorUserId = amuxPortfolioOwnerId(session);
  if (!/^[a-f0-9-]{36}$/.test(requestId)) {
    throw new AmuxPortfolioError("not_found");
  }
  const row = await prisma.amuxPortfolioScoreSnapshot.findFirst({ where: {
    requestId, approvedByUserId: actorUserId },
    select: { id: true, taskId: true, scoreVersion: true,
      scoreTotal: true, components: true, evidenceAsOf: true,
      activeStaleAt: true, baselineStaleAt: true,
      inputDigest: true, approvalAuditLogId: true,
      initiativeAssessment: { select: { nodeId: true, metrics: true,
        uncertainty: true, evidenceRefs: true, evidenceAsOf: true } },
      epicAssessment: { select: { nodeId: true, metrics: true,
        uncertainty: true, evidenceRefs: true, evidenceAsOf: true } },
      featureAssessment: { select: { nodeId: true, metrics: true,
        uncertainty: true, evidenceRefs: true, evidenceAsOf: true } },
      storyAssessment: { select: { cardId: true, metrics: true,
        uncertainty: true, evidenceRefs: true, evidenceAsOf: true } },
      taskAssessment: { select: { cardId: true, metrics: true,
        uncertainty: true, evidenceRefs: true, evidenceAsOf: true } },
    },
  });
  if (!row) return { state: "not_found" as const };
  const audit = await prisma.adminAuditLog.findUnique({ where: {
    id: row.approvalAuditLogId },
    select: { action: true, targetId: true, actorUserId: true,
      entryHash: true },
  });
  if (!audit?.entryHash || audit.action !==
      "amux.v4.portfolio.score.confirm" ||
      audit.targetId !== row.id || audit.actorUserId !== actorUserId) {
    throw new AmuxPortfolioError("integrity_unavailable");
  }
  const now = Date.now();
  return { state: "confirmed" as const, scoreId: row.id,
    taskId: row.taskId, scoreVersion: row.scoreVersion,
    scoreTotal: row.scoreTotal, components: row.components,
    evidenceAsOf: row.evidenceAsOf.toISOString(),
    activeStaleAt: row.activeStaleAt.toISOString(),
    baselineStaleAt: row.baselineStaleAt.toISOString(),
    activeFresh: now < row.activeStaleAt.getTime(),
    baselineFresh: now < row.baselineStaleAt.getTime(),
    inputDigest: row.inputDigest,
    evidence: { initiative: row.initiativeAssessment,
      epic: row.epicAssessment, feature: row.featureAssessment,
      story: row.storyAssessment, task: row.taskAssessment } };
}

export async function readLatestAmuxPortfolioScore(session: Session,
  taskId: string) {
  const actorUserId = amuxPortfolioOwnerId(session);
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(taskId)) {
    throw new AmuxPortfolioError("not_found");
  }
  const row = await prisma.amuxPortfolioScoreSnapshot.findFirst({ where: {
    taskId, approvedByUserId: actorUserId },
    orderBy: [{ computedAt: "desc" }, { id: "desc" }],
    select: { requestId: true },
  });
  return row ? readAmuxPortfolioScore(session, row.requestId) :
    { state: "not_found" as const };
}
