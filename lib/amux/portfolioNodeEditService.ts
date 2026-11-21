import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, openAmuxContent, sealAmuxContent,
  verifyAmuxContentDigest, type AmuxContentKeys, type AmuxDigestKey } from
  "./ideaCrypto.ts";
import { loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { readAmuxPortfolioClock } from "./portfolioClock.ts";
import { amuxPortfolioOwnerId, AmuxPortfolioError,
  writeAmuxPortfolioAssessmentInTx } from "./portfolioAssessmentService.ts";
import { AMUX_NODE_REVISE_ACTION, AMUX_NODE_REVISE_TARGET,
  amuxNodeEditBinding, amuxNodeEditEvidenceRef, amuxNodeEditReasonFits,
  amuxProjectedTaskScore, type AmuxNodeEditTaskInputs, type AmuxPortfolioNodeEditPayload,
  type AmuxPortfolioNodeLevel } from "./portfolioNodeEditCore.ts";
import { writeAmuxPortfolioScoreInTx } from "./portfolioScoreService.ts";

/** Owner decision 2026-11-21 (docs/policy/amux-intake.md). The owner edits an
 * active Initiative, Epic or Feature. Errors reuse AmuxPortfolioError so the
 * portfolio route answers them the way it answers an assessment. */

type Db = Prisma.TransactionClient | typeof prisma;
export type AmuxNodeKeyLoader = (identity: { ideaId: string;
  purpose: "node_content"; subjectId: string }) => Promise<AmuxContentKeys>;
export type AmuxNodeEditDeps = { loadKeys?: AmuxNodeKeyLoader };

const LEVELS = new Set(["initiative", "epic", "feature"]);
const defaultLoader: AmuxNodeKeyLoader = (identity) => loadAmuxContentUnitKeys(identity);

const nodeSelect = { id: true, level: true, parentId: true, state: true,
  revision: true, displayPrefix: true, titleCiphertext: true,
  descriptionCiphertext: true, contentKeyId: true, contentKeyVersion: true,
  contentDigest: true, contentDigestKeyId: true } as const;
type NodeRow = Prisma.AmuxPortfolioNodeGetPayload<{ select: typeof nodeSelect }>;

/** The node and the idea whose unit key seals its content. Every revision
 * keeps the creating decision (the migration requires it), so the key scope
 * never moves. */
async function nodeContext(db: Db, nodeId: string) {
  const node = await db.amuxPortfolioNode.findUnique({ where: { id: nodeId },
    select: nodeSelect });
  if (!node || !LEVELS.has(node.level)) throw new AmuxPortfolioError("not_found");
  const revision = await db.amuxPortfolioNodeRevision.findUnique({
    where: { nodeId_revision: { nodeId, revision: node.revision } },
    select: { decisionId: true, contentDigest: true, contentDigestKeyId: true } });
  const decision = revision ? await db.amuxIdeaUnitDecision.findUnique({
    where: { id: revision.decisionId }, select: { ideaId: true } }) : null;
  if (!revision || !decision || revision.contentDigest !== node.contentDigest ||
      revision.contentDigestKeyId !== node.contentDigestKeyId) {
    throw new AmuxPortfolioError("integrity_unavailable");
  }
  return { node, decisionId: revision.decisionId, ideaId: decision.ideaId,
    level: node.level as AmuxPortfolioNodeLevel };
}

/** Open Tasks under the node, across Epics and Features: the Tasks whose
 * score this node's value feeds. */
async function affectedTasks(db: Db, nodeId: string) {
  return db.$queryRaw<Array<{ id: string; displayKey: string | null; revision: number;
    parentFeatureNodeId: string; parentStoryCardId: string | null }>>`
    WITH RECURSIVE tree("id", "depth") AS (
      SELECT "id", 0 FROM "AmuxPortfolioNode" WHERE "id" = ${nodeId}
      UNION ALL
      SELECT child."id", tree."depth" + 1 FROM tree
      JOIN "AmuxPortfolioNode" child ON child."parentId" = tree."id"
      WHERE child."state" = 'active' AND tree."depth" < 2
    )
    SELECT card."id", card."displayKey", card."revision", card."parentFeatureNodeId",
      card."parentStoryCardId" FROM tree
    JOIN "AmuxWorkItem" card ON card."parentFeatureNodeId" = tree."id"
    WHERE card."cardType" = 'task' AND card."sourceSystem" = 'admin-idea-v4'
      AND card."status" NOT IN ('done', 'cancelled') AND card."archivedAt" IS NULL
    ORDER BY card."displayKey" ASC NULLS LAST, card."id" ASC`;
}

/** What each affected Task's score is calculated from, as read now: the
 * latest score, and every subject on its path with its revision and latest
 * assessment (portfolioScoreService.ts buildScorePlan reads the same). */
async function taskScoreInputs(db: Db,
  tasks: Awaited<ReturnType<typeof affectedTasks>>) {
  const latestScore = new Map<string, { id: string; scoreTotal: number; components: unknown }>();
  if (tasks.length === 0) return { latestScore, inputs: [] as AmuxNodeEditTaskInputs[] };
  const storyIds = [...new Set(tasks.flatMap((task) =>
    task.parentStoryCardId ? [task.parentStoryCardId] : []))];
  const stories = storyIds.length === 0 ? [] : await db.amuxWorkItem.findMany({
    where: { id: { in: storyIds } }, select: { id: true, revision: true } });
  const nodes = new Map<string, { parentId: string | null; revision: number }>();
  let frontier = [...new Set(tasks.map((task) => task.parentFeatureNodeId))];
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const rows = await db.amuxPortfolioNode.findMany({ where: { id: { in: frontier } },
      select: { id: true, parentId: true, revision: true } });
    for (const row of rows) nodes.set(row.id, row);
    frontier = [...new Set(rows.flatMap((row) =>
      row.parentId && !nodes.has(row.parentId) ? [row.parentId] : []))];
  }
  const taskIds = tasks.map((task) => task.id);
  const cardIds = [...taskIds, ...storyIds];
  const [scores, assessments] = await Promise.all([
    db.$queryRaw<Array<{ taskId: string; id: string; scoreTotal: number; components: unknown }>>`
      SELECT DISTINCT ON ("taskId") "taskId", "id"::text AS "id", "scoreTotal", "components"
      FROM "AmuxPortfolioScoreSnapshot" WHERE "taskId" = ANY(${taskIds}::text[])
      ORDER BY "taskId", "computedAt" DESC, "id" DESC`,
    db.$queryRaw<Array<{ subjectId: string; id: string }>>`
      SELECT DISTINCT ON (COALESCE("nodeId", "cardId"))
        COALESCE("nodeId", "cardId") AS "subjectId", "id"::text AS "id"
      FROM "AmuxPortfolioAssessment"
      WHERE "nodeId" = ANY(${[...nodes.keys()]}::text[]) OR "cardId" = ANY(${cardIds}::text[])
      ORDER BY COALESCE("nodeId", "cardId"), "assessmentVersion" DESC`,
  ]);
  for (const row of scores) latestScore.set(row.taskId, row);
  const latestAssessment = new Map(assessments.map((row) => [row.subjectId, row.id]));
  const storyRevision = new Map(stories.map((row) => [row.id, row.revision]));
  const subject = (subjectId: string, revision: number | null) => ({ subjectId, revision,
    assessmentId: latestAssessment.get(subjectId) ?? null });
  const inputs = tasks.map((task) => {
    const path: Array<ReturnType<typeof subject>> = [];
    for (let id: string | null = task.parentFeatureNodeId, depth = 0; id && depth < 3; depth++) {
      const row = nodes.get(id);
      path.unshift(subject(id, row?.revision ?? null));
      id = row?.parentId ?? null;
    }
    if (task.parentStoryCardId) path.push(subject(task.parentStoryCardId,
      storyRevision.get(task.parentStoryCardId) ?? null));
    path.push(subject(task.id, task.revision));
    return { taskId: task.id, scoreId: latestScore.get(task.id)?.id ?? null, inputs: path };
  });
  return { latestScore, inputs };
}

const contentBody = (title: string, description: string) =>
  Buffer.from(amuxCanonicalJson({ title, description }), "utf8");

type Plan = {
  level: AmuxPortfolioNodeLevel; node: NodeRow; decisionId: string;
  nextContent: { digest: string; digestKeyId: string } | null;
  priorValue: number | null; tasks: Array<{ id: string; displayKey: string | null }>;
  latestScore: Map<string, { scoreTotal: number; components: unknown }>;
  confirmationDigest: string;
};

async function buildPlan(db: Db, actorUserId: string,
  payload: AmuxPortfolioNodeEditPayload, digestKey: AmuxDigestKey,
  keys: AmuxContentKeys | null, context?: Awaited<ReturnType<typeof nodeContext>>,
): Promise<Plan> {
  const { node, decisionId, level } = context ?? await nodeContext(db, payload.nodeId);
  if (node.state !== "active") throw new AmuxPortfolioError("not_ready");
  if (node.revision !== payload.expectedRevision) throw new AmuxPortfolioError("reconfirm");
  const evidenceAsOf = new Date(payload.evidenceAsOf);
  if (!Number.isFinite(evidenceAsOf.getTime()) || evidenceAsOf.getTime() > Date.now()) {
    throw new AmuxPortfolioError("invalid_input");
  }
  let nextContent: Plan["nextContent"] = null;
  if (payload.content) {
    if (!keys) throw new AmuxPortfolioError("integrity_unavailable");
    const body = contentBody(payload.content.title, payload.content.description);
    try {
      const digest = amuxContentDigest(body, "node_content", node.id, keys);
      // The same text under the same key is no revision.
      nextContent = digest.digest === node.contentDigest &&
        digest.digestKeyId === node.contentDigestKeyId ? null : digest;
    } finally { body.fill(0); }
  }
  const prior = await db.amuxPortfolioAssessment.findFirst({
    where: { nodeId: node.id }, orderBy: { assessmentVersion: "desc" },
    select: { id: true, metrics: true } });
  if (!amuxNodeEditReasonFits(payload.reasonCode, prior !== null)) {
    throw new AmuxPortfolioError("reconfirm");
  }
  const priorValue = prior && typeof (prior.metrics as Record<string, unknown>)?.value === "number" ?
    (prior.metrics as Record<string, number>).value : null;
  const tasks = await affectedTasks(db, node.id);
  const { latestScore, inputs } = await taskScoreInputs(db, tasks);
  const canonical = Buffer.from(amuxCanonicalJson(amuxNodeEditBinding({
    actorUserId, payload, level, priorContentDigest: node.contentDigest,
    nextContentDigest: nextContent?.digest ?? null,
    priorAssessmentId: prior?.id ?? null, affectedTasks: inputs })), "utf8");
  try {
    const digest = amuxContentDigest(canonical, "portfolio_assessment",
      payload.id, digestKey);
    return { level, node, decisionId, nextContent, priorValue, tasks, latestScore,
      confirmationDigest: digest.digest };
  } finally { canonical.fill(0); }
}

async function keysFor(context: { ideaId: string; node: { id: string } },
  payload: AmuxPortfolioNodeEditPayload, deps: AmuxNodeEditDeps) {
  if (!payload.content) return null;
  try {
    return await (deps.loadKeys ?? defaultLoader)({ ideaId: context.ideaId,
      purpose: "node_content", subjectId: context.node.id });
  } catch { throw new AmuxPortfolioError("integrity_unavailable"); }
}

export async function previewAmuxPortfolioNodeEdit(session: Session,
  payload: AmuxPortfolioNodeEditPayload, digestKey: AmuxDigestKey,
  deps: AmuxNodeEditDeps = {}) {
  const actorUserId = amuxPortfolioOwnerId(session);
  const context = await nodeContext(prisma, payload.nodeId);
  const keys = await keysFor(context, payload, deps);
  try {
    const plan = await buildPlan(prisma, actorUserId, payload, digestKey, keys, context);
    const latest = plan.latestScore;
    return {
      confirmationDigest: plan.confirmationDigest, level: plan.level,
      contentChanged: plan.nextContent !== null,
      revisionAfter: plan.node.revision + (plan.nextContent ? 1 : 0),
      priorValue: plan.priorValue, nextValue: payload.value,
      tasks: plan.tasks.map((task) => {
        const current = latest.get(task.id) ?? null;
        return { taskId: task.id, displayKey: task.displayKey,
          currentScore: current?.scoreTotal ?? null,
          projectedScore: amuxProjectedTaskScore({ level: plan.level,
            nextValue: payload.value, currentTotal: current?.scoreTotal ?? null,
            currentComponents: current?.components ?? null }) };
      }),
    };
  } finally { keys?.masterKey.fill(0); }
}

export type AmuxNodeEditTaskOutcome =
  | { taskId: string; state: "scored"; scoreTotal: number }
  | { taskId: string; state: "skipped" };

/** One owner save in one transaction: chain lock, node lock, the plan the
 * preview showed, the content revision when the text changed, the
 * assessment, and every open Task's score through the score writer. A Task
 * whose own inputs are not ready keeps its last score and is reported. */
export async function saveAmuxPortfolioNodeEdit(input: {
  session: Session; request: Request; payload: AmuxPortfolioNodeEditPayload;
  confirmationDigest: string; digestKey: AmuxDigestKey; deps?: AmuxNodeEditDeps;
}) {
  const actorUserId = amuxPortfolioOwnerId(input.session);
  await assertRecentAdminAuthentication(input.session);
  const { payload } = input;
  const context = await nodeContext(prisma, payload.nodeId);
  const keys = await keysFor(context, payload, input.deps ?? {});
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await takeAuditChainLock(tx);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxPortfolioNode" WHERE "id" = ${payload.nodeId} FOR UPDATE`;
      if (locked.length !== 1) throw new AmuxPortfolioError("not_found");
      if (await tx.amuxPortfolioAssessment.findUnique({ where: {
        requestId: payload.requestId }, select: { id: true } })) {
        throw new AmuxPortfolioError("reconfirm");
      }
      const current = await nodeContext(tx, payload.nodeId);
      if (current.ideaId !== context.ideaId) throw new AmuxPortfolioError("reconfirm");
      const plan = await buildPlan(tx, actorUserId, payload, input.digestKey,
        keys, current);
      if (plan.confirmationDigest !== input.confirmationDigest) {
        throw new AmuxPortfolioError("reconfirm");
      }
      let revision = plan.node.revision;
      let revisionAuditId: string | null = null;
      if (plan.nextContent && payload.content && keys) {
        const title = sealAmuxContent(Buffer.from(payload.content.title, "utf8"),
          "node_content", plan.node.id, keys);
        const description = sealAmuxContent(
          Buffer.from(payload.content.description, "utf8"),
          "node_content", plan.node.id, keys);
        revision = plan.node.revision + 1;
        revisionAuditId = await writeAdminAuditLog({ tx, session: input.session,
          request: input.request, action: AMUX_NODE_REVISE_ACTION,
          targetType: AMUX_NODE_REVISE_TARGET, targetId: plan.node.id,
          summary: "Revised one AMUX portfolio node's title and description.",
          metadata: { level: plan.level, priorRevision: plan.node.revision,
            revision, requestId: payload.requestId,
            priorContentDigest: plan.node.contentDigest,
            contentDigest: plan.nextContent.digest,
            contentDigestKeyId: plan.nextContent.digestKeyId } });
        if (!revisionAuditId) throw new AmuxPortfolioError("integrity_unavailable");
        await tx.amuxPortfolioNodeRevision.create({ data: {
          id: randomUUID(), nodeId: plan.node.id, revision,
          priorRevision: plan.node.revision, parentIdAtApproval: plan.node.parentId,
          contentDigest: plan.nextContent.digest,
          contentDigestKeyId: plan.nextContent.digestKeyId,
          decisionId: plan.decisionId, authorizationAuditLogId: revisionAuditId,
          approvedAt: await readAmuxPortfolioClock(tx) } });
        const updated = await tx.amuxPortfolioNode.updateMany({
          where: { id: plan.node.id, revision: plan.node.revision, state: "active" },
          data: { revision,
            titleCiphertext: new Uint8Array(title.ciphertext),
            descriptionCiphertext: new Uint8Array(description.ciphertext),
            contentKeyId: title.keyId, contentKeyVersion: title.keyVersion,
            contentDigest: plan.nextContent.digest,
            contentDigestKeyId: plan.nextContent.digestKeyId,
            approvedByUserId: actorUserId,
            authorizationAuditLogId: revisionAuditId } });
        if (updated.count !== 1) throw new AmuxPortfolioError("reconfirm");
      }
      const assessment = await writeAmuxPortfolioAssessmentInTx(tx, {
        session: input.session, request: input.request, confirmationDigest: null,
        digestKey: input.digestKey, payload: { id: payload.id,
          requestId: payload.requestId,
          subject: { kind: plan.level, id: plan.node.id },
          metrics: { value: payload.value }, uncertainty: payload.uncertainty,
          evidenceRefs: [amuxNodeEditEvidenceRef(plan.node.id, revision)],
          evidenceAsOf: payload.evidenceAsOf, reasonCode: payload.reasonCode,
          modelProposalDigest: null } });
      const tasks: AmuxNodeEditTaskOutcome[] = [];
      for (const task of plan.tasks) {
        try {
          const written = await writeAmuxPortfolioScoreInTx(tx, {
            session: input.session, request: input.request,
            confirmationDigest: null, digestKey: input.digestKey,
            payload: { id: randomUUID(), requestId: randomUUID(), taskId: task.id } });
          tasks.push({ taskId: task.id, state: "scored",
            scoreTotal: written.score.total });
        } catch (error) {
          if (error instanceof AmuxPortfolioError && error.code === "not_ready") {
            tasks.push({ taskId: task.id, state: "skipped" });
            continue;
          }
          throw error;
        }
      }
      return { state: "saved" as const, nodeId: plan.node.id, revision,
        contentRevised: revisionAuditId !== null, revisionAuditId,
        assessmentId: assessment.assessmentId,
        assessmentVersion: assessment.assessmentVersion,
        assessmentAuditId: assessment.auditId, tasks };
    }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 60_000 });
  } finally { keys?.masterKey.fill(0); }
}

/** The edit panel's read: decrypted title and description, the latest value
 * assessment and whether it is bound to the current revision. */
export async function readAmuxPortfolioNodeForEdit(session: Session,
  nodeId: string, deps: AmuxNodeEditDeps = {}) {
  amuxPortfolioOwnerId(session);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(nodeId)) throw new AmuxPortfolioError("not_found");
  const context = await nodeContext(prisma, nodeId);
  const { node } = context;
  let content: { title: string; description: string } | null = null;
  if (node.state === "active" && node.titleCiphertext && node.descriptionCiphertext &&
      node.contentKeyId && node.contentKeyVersion) {
    let keys: AmuxContentKeys | null = null;
    try {
      keys = await (deps.loadKeys ?? defaultLoader)({ ideaId: context.ideaId,
        purpose: "node_content", subjectId: node.id });
      const envelope = { keyId: node.contentKeyId, keyVersion: node.contentKeyVersion };
      const title = openAmuxContent({ ...envelope,
        ciphertext: Buffer.from(node.titleCiphertext) }, "node_content", node.id, keys);
      const description = openAmuxContent({ ...envelope,
        ciphertext: Buffer.from(node.descriptionCiphertext) }, "node_content", node.id, keys);
      try {
        const body = contentBody(title.toString("utf8"), description.toString("utf8"));
        try {
          if (verifyAmuxContentDigest(body, "node_content", node.id,
            node.contentDigest, node.contentDigestKeyId, keys)) {
            content = { title: title.toString("utf8"),
              description: description.toString("utf8") };
          }
        } finally { body.fill(0); }
      } finally { title.fill(0); description.fill(0); }
    } catch { content = null; } finally { keys?.masterKey.fill(0); }
  }
  const latest = await prisma.amuxPortfolioAssessment.findFirst({
    where: { nodeId }, orderBy: { assessmentVersion: "desc" },
    select: { assessmentVersion: true, subjectRevision: true, metrics: true,
      uncertainty: true, evidenceAsOf: true, reasonCode: true } });
  const value = latest && typeof (latest.metrics as Record<string, unknown>)?.value === "number" ?
    (latest.metrics as Record<string, number>).value : null;
  return { id: node.id, level: context.level, state: node.state,
    revision: node.revision, displayPrefix: node.displayPrefix, content,
    // An archived node is read-only. An unreadable body keeps the value
    // editable but never offers a text field to overwrite unseen text.
    editable: node.state === "active", contentEditable: content !== null,
    assessment: latest ? { version: latest.assessmentVersion, value,
      uncertainty: latest.uncertainty, reasonCode: latest.reasonCode,
      evidenceAsOf: latest.evidenceAsOf.toISOString(),
      bound: latest.subjectRevision === node.revision } : null };
}
