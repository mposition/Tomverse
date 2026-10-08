import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import { readAmuxV22TaskResultForOwner } from "./v22TaskResultStore.ts";
import { amuxFeedbackTaskWhere, projectAmuxTaskFeedback, readAmuxV4ApprovedCeiling,
  rollupAmuxTaskFeedback } from
  "./v22TaskFeedbackCore.ts";
import { AMUX_V22_OUTCOME_ACTION, AMUX_V22_OUTCOME_TARGET,
  AMUX_V22_OUTCOME_WRITE_ENV, amuxV22OutcomeWriteEnabled,
  readAmuxV22ObservationMetadata } from "./v22OutcomeObservationCore.ts";
import { normalizeAmuxUntrustedReason,
  storedAmuxEscalationReasonCode } from "./escalation.ts";
import {
  AMUX_EXECUTION_LANES, AMUX_EXECUTION_PAGE_SIZE,
  AMUX_EXECUTION_VISIBLE_LANES,
  amuxExecutionLaneWhere, type AmuxExecutionLane,
} from "./adminExecutionViewCore.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cardSelect = {
  id: true, title: true, sourceKey: true, sourceSystem: true,
  sourceSnapshot: true, status: true, priority: true, kind: true,
  cardType: true, storyKind: true, parentFeatureNodeId: true,
  parentStoryCardId: true, taskRole: true, executionGrade: true,
  v22AssignmentId: true, executionBriefDigest: true, v4BriefDigest: true,
  v4TitleCiphertext: true, v4TitleKeyId: true, v4TitleKeyVersion: true,
  v4TitleDigest: true, v4TitleDigestKeyId: true, updatedAt: true,
  v4SourceApprovalId: true,
  archivedAt: true, revision: true,
  v22AcceptedAssignment: { select: { workerName: true, lane: true,
    assignedAt: true } },
} as const;

type CardRow = Awaited<ReturnType<typeof prisma.amuxWorkItem.findMany<{
  select: typeof cardSelect;
}>>>[number];

function ideaIdFromSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      !("ideaId" in snapshot)) return null;
  const ideaId = snapshot.ideaId;
  return typeof ideaId === "string" && UUID.test(ideaId) ? ideaId : null;
}

async function cardTitle(row: CardRow): Promise<string | null> {
  if (row.sourceSystem !== "admin-idea-v4") return row.title;
  const ideaId = ideaIdFromSnapshot(row.sourceSnapshot);
  if (!ideaId || !row.v4TitleCiphertext || !row.v4TitleKeyId ||
      !row.v4TitleKeyVersion || !row.v4TitleDigest || !row.v4TitleDigestKeyId)
    return null;
  try {
    const keys = await loadAmuxContentUnitKeys({ ideaId,
      purpose: "card_title", subjectId: row.id });
    let plain: Buffer | null = null;
    try {
      plain = openAmuxContent({ ciphertext: Buffer.from(row.v4TitleCiphertext),
        keyId: row.v4TitleKeyId, keyVersion: row.v4TitleKeyVersion },
      "card_title", row.id, keys);
      return verifyAmuxContentDigest(plain, "card_title", row.id,
        row.v4TitleDigest, row.v4TitleDigestKeyId, keys) ?
        plain.toString("utf8") : null;
    } finally { plain?.fill(0); keys.masterKey.fill(0); }
  } catch { return null; }
}

async function cardSummaries(rows: CardRow[]) {
  const ids = rows.map((row) => row.id);
  const storyIds = rows.filter((row) => row.cardType === "story").map((row) => row.id);
  const [titles, scores, dependencies, lanes, progress] = await Promise.all([
    Promise.all(rows.map(cardTitle)),
    ids.length ? prisma.$queryRaw<Array<{ taskId: string;
      taskRevision: number; scoreTotal: number; activeStaleAt: Date }>>`
      SELECT DISTINCT ON ("taskId") "taskId", "taskRevision",
        "scoreTotal", "activeStaleAt"
      FROM "AmuxPortfolioScoreSnapshot"
      WHERE "taskId" = ANY(${ids}::text[])
      ORDER BY "taskId", "computedAt" DESC, "id" DESC
    ` : [],
    ids.length ? prisma.amuxWorkDependency.groupBy({
      by: ["taskId"], where: { taskId: { in: ids } }, _count: { _all: true },
    }) : [],
    ids.length ? prisma.$queryRaw<Array<{ workItemId: string; lane: string }>>`
      SELECT DISTINCT ON ("workItemId") "workItemId", "lane"
      FROM "AmuxV22LaneDecision"
      WHERE "workItemId" = ANY(${ids}::text[])
      ORDER BY "workItemId", "sequence" DESC
    ` : [],
    storyIds.length ? prisma.amuxWorkItem.groupBy({
      by: ["parentStoryCardId", "status"],
      where: { parentStoryCardId: { in: storyIds }, cardType: "task",
        archivedAt: null },
      _count: { _all: true },
    }) : [],
  ]);
  const latestScore = new Map(scores.map((score) => [score.taskId, score]));
  const dependencyCount = new Map(dependencies.map((row) =>
    [row.taskId, row._count._all]));
  const latestLane = new Map(lanes.map((row) => [row.workItemId, row.lane]));
  const storyProgress = new Map<string, { done: number; total: number }>();
  for (const row of progress) {
    if (!row.parentStoryCardId) continue;
    const prior = storyProgress.get(row.parentStoryCardId) ?? { done: 0, total: 0 };
    prior.total += row._count._all;
    if (row.status === "done") prior.done += row._count._all;
    storyProgress.set(row.parentStoryCardId, prior);
  }
  return rows.map((row, index) => ({
    id: row.id,
    title: titles[index],
    sourceKey: row.sourceKey,
    status: row.status,
    priority: row.priority,
    kind: row.kind,
    cardType: row.cardType,
    storyKind: row.storyKind,
    parentFeatureNodeId: row.parentFeatureNodeId,
    parentStoryCardId: row.parentStoryCardId,
    taskRole: row.taskRole,
    executionGrade: row.executionGrade,
    worker: row.v22AcceptedAssignment?.workerName ?? null,
    lane: latestLane.get(row.id) ?? row.v22AcceptedAssignment?.lane ?? null,
    sev1: (latestLane.get(row.id) ?? row.v22AcceptedAssignment?.lane) === "sev1",
    score: latestScore.get(row.id)?.taskRevision === row.revision ?
      latestScore.get(row.id)!.scoreTotal : null,
    scoreFresh: latestScore.get(row.id)?.taskRevision === row.revision &&
      latestScore.get(row.id)!.activeStaleAt.getTime() > new Date().getTime(),
    dependencyCount: dependencyCount.get(row.id) ?? 0,
    progress: storyProgress.get(row.id) ?? null,
    briefPresent: Boolean(row.executionBriefDigest || row.v4BriefDigest),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export type AmuxExecutionCardSummary = Awaited<ReturnType<typeof cardSummaries>>[number];

export async function readAmuxExecutionBoard(lane: AmuxExecutionLane, page: number) {
  const where = amuxExecutionLaneWhere(lane);
  const [counts, rows] = await Promise.all([
    Promise.all(AMUX_EXECUTION_LANES.map(async (name) => ({
      lane: name, total: await prisma.amuxWorkItem.count({
        where: amuxExecutionLaneWhere(name),
      }),
    }))),
    prisma.amuxWorkItem.findMany({ where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: page * AMUX_EXECUTION_PAGE_SIZE,
      take: AMUX_EXECUTION_PAGE_SIZE,
      select: cardSelect,
    }),
  ]);
  return { lane, page, pageSize: AMUX_EXECUTION_PAGE_SIZE,
    counts: Object.fromEntries(counts.map((item) => [item.lane, item.total])) as
      Record<AmuxExecutionLane, number>,
    cards: await cardSummaries(rows) };
}

export async function readAmuxExecutionBoardSnapshot() {
  const [counts, pages] = await Promise.all([
    Promise.all(AMUX_EXECUTION_LANES.map(async (name) => ({
      lane: name, total: await prisma.amuxWorkItem.count({
        where: amuxExecutionLaneWhere(name),
      }),
    }))),
    Promise.all(AMUX_EXECUTION_VISIBLE_LANES.map(async (lane) => ({ lane,
      rows: await prisma.amuxWorkItem.findMany({
        where: amuxExecutionLaneWhere(lane),
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: AMUX_EXECUTION_PAGE_SIZE, select: cardSelect,
      }),
    }))),
  ]);
  const summaries = await cardSummaries(pages.flatMap((page) => page.rows));
  const byId = new Map(summaries.map((card) => [card.id, card]));
  return { pageSize: AMUX_EXECUTION_PAGE_SIZE,
    counts: Object.fromEntries(counts.map((item) => [item.lane, item.total])) as
      Record<AmuxExecutionLane, number>,
    lanes: pages.map((page) => ({ lane: page.lane,
      cards: page.rows.map((row) => byId.get(row.id)!) })),
  };
}

type NodeRow = Awaited<ReturnType<typeof prisma.amuxPortfolioNode.findMany<{
  select: typeof nodeSelect;
}>>>[number];

const nodeSelect = {
  id: true, level: true, parentId: true, state: true, revision: true,
  titleCiphertext: true, descriptionCiphertext: true,
  contentKeyId: true, contentKeyVersion: true,
  contentDigest: true, contentDigestKeyId: true,
} as const;

async function nodeTitles(rows: NodeRow[]) {
  if (rows.length === 0) return [];
  const revisions = await prisma.amuxPortfolioNodeRevision.findMany({
    where: { OR: rows.map((row) => ({ nodeId: row.id, revision: row.revision })) },
    select: { nodeId: true, revision: true, decisionId: true },
  });
  const decisions = await prisma.amuxIdeaUnitDecision.findMany({
    where: { id: { in: revisions.map((row) => row.decisionId) } },
    select: { id: true, ideaId: true },
  });
  const ideaByDecision = new Map(decisions.map((row) => [row.id, row.ideaId]));
  return Promise.all(rows.map(async (row) => {
    const revision = revisions.find((item) => item.nodeId === row.id &&
      item.revision === row.revision);
    const ideaId = revision ? ideaByDecision.get(revision.decisionId) : null;
    if (!ideaId || !row.titleCiphertext || !row.descriptionCiphertext ||
        !row.contentKeyId || !row.contentKeyVersion) return null;
    try {
      const keys = await loadAmuxContentUnitKeys({ ideaId,
        purpose: "node_content", subjectId: row.id });
      const envelope = { keyId: row.contentKeyId,
        keyVersion: row.contentKeyVersion };
      let title: Buffer | null = null;
      let description: Buffer | null = null;
      try {
        title = openAmuxContent({ ...envelope,
          ciphertext: Buffer.from(row.titleCiphertext) },
        "node_content", row.id, keys);
        description = openAmuxContent({ ...envelope,
          ciphertext: Buffer.from(row.descriptionCiphertext) },
        "node_content", row.id, keys);
        const body = Buffer.from(amuxCanonicalJson({ title: title.toString("utf8"),
          description: description.toString("utf8") }), "utf8");
        try {
          return verifyAmuxContentDigest(body, "node_content", row.id,
            row.contentDigest, row.contentDigestKeyId, keys) ?
            title.toString("utf8") : null;
        } finally { body.fill(0); }
      } finally { title?.fill(0); description?.fill(0);
        keys.masterKey.fill(0); }
    } catch { return null; }
  }));
}

async function nodeIndicators(rows: NodeRow[]) {
  if (rows.length === 0) return new Map<string, {
    assessment: unknown; progress: { done: number; total: number } }>();
  const ids = rows.map((row) => row.id);
  const [assessments, counts] = await Promise.all([
    prisma.$queryRaw<Array<{ nodeId: string; subjectRevision: number;
      metrics: unknown; evidenceAsOf: Date }>>`
      SELECT DISTINCT ON ("nodeId") "nodeId", "subjectRevision",
        "metrics", "evidenceAsOf"
      FROM "AmuxPortfolioAssessment"
      WHERE "nodeId" = ANY(${ids}::text[])
      ORDER BY "nodeId", "approvedAt" DESC, "id" DESC
    `,
    prisma.$queryRaw<Array<{ rootId: string; total: number; done: number }>>`
      WITH RECURSIVE descendants("rootId", "id", "depth") AS (
        SELECT "id", "id", 0 FROM "AmuxPortfolioNode"
        WHERE "id" = ANY(${ids}::text[])
        UNION ALL
        SELECT d."rootId", child."id", d."depth" + 1
        FROM descendants d
        JOIN "AmuxPortfolioNode" child ON child."parentId" = d."id"
        WHERE child."state" = 'active' AND d."depth" < 2
      )
      SELECT d."rootId", COUNT(card."id")::int AS "total",
        COUNT(card."id") FILTER (WHERE card."status" = 'done')::int AS "done"
      FROM descendants d
      LEFT JOIN "AmuxWorkItem" card ON card."parentFeatureNodeId" = d."id"
        AND card."cardType" = 'task'
        AND card."archivedAt" IS NULL
      GROUP BY d."rootId"
    `,
  ]);
  const latest = new Map(assessments.map((item) => [item.nodeId, item]));
  const progress = new Map(counts.map((row) => [row.rootId,
    { done: row.done, total: row.total }]));
  return new Map(rows.map((row) => [row.id, {
    assessment: latest.get(row.id)?.subjectRevision === row.revision ?
      latest.get(row.id)?.metrics ?? null : null,
    progress: progress.get(row.id) ?? { done: 0, total: 0 },
  }]));
}

export type AmuxHierarchyParent = { kind: "root" } | { kind: "unassigned" } |
  { kind: "node" | "story"; id: string };

export async function readAmuxExecutionHierarchy(parent: AmuxHierarchyParent,
  page: number) {
  const skip = page * AMUX_EXECUTION_PAGE_SIZE;
  if (parent.kind === "unassigned") {
    const where = { parentFeatureNodeId: null,
      parentStoryCardId: null, archivedAt: null };
    const [total, cards] = await Promise.all([
      prisma.amuxWorkItem.count({ where }),
      prisma.amuxWorkItem.findMany({ where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip, take: AMUX_EXECUTION_PAGE_SIZE, select: cardSelect }),
    ]);
    return { parent, page, pageSize: AMUX_EXECUTION_PAGE_SIZE,
      total, items: (await cardSummaries(cards)).map((card) => ({
        type: "card" as const, ...card })) };
  }
  if (parent.kind === "story") {
    const story = await prisma.amuxWorkItem.findUnique({ where: { id: parent.id },
      select: { id: true, cardType: true, archivedAt: true } });
    if (!story || story.cardType !== "story" || story.archivedAt) return null;
    const where = { parentStoryCardId: parent.id, archivedAt: null };
    const [total, cards] = await Promise.all([
      prisma.amuxWorkItem.count({ where }),
      prisma.amuxWorkItem.findMany({ where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip, take: AMUX_EXECUTION_PAGE_SIZE, select: cardSelect }),
    ]);
    return { parent, page, pageSize: AMUX_EXECUTION_PAGE_SIZE,
      total, items: (await cardSummaries(cards)).map((card) => ({
        type: "card" as const, ...card })) };
  }
  if (parent.kind === "node") {
    const node = await prisma.amuxPortfolioNode.findUnique({
      where: { id: parent.id }, select: { level: true, state: true } });
    if (!node || node.state !== "active") return null;
    if (node.level === "feature") {
      const where = { parentFeatureNodeId: parent.id,
        parentStoryCardId: null, archivedAt: null };
      const [total, cards] = await Promise.all([
        prisma.amuxWorkItem.count({ where }),
        prisma.amuxWorkItem.findMany({ where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip, take: AMUX_EXECUTION_PAGE_SIZE, select: cardSelect }),
      ]);
      return { parent, page, pageSize: AMUX_EXECUTION_PAGE_SIZE,
        total, items: (await cardSummaries(cards)).map((card) => ({
          type: "card" as const, ...card })) };
    }
  }
  const where = { parentId: parent.kind === "root" ? null : parent.id,
    state: "active" };
  const [total, nodes] = await Promise.all([
    prisma.amuxPortfolioNode.count({ where }),
    prisma.amuxPortfolioNode.findMany({ where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip, take: AMUX_EXECUTION_PAGE_SIZE, select: nodeSelect }),
  ]);
  const [titles, indicators] = await Promise.all([
    nodeTitles(nodes), nodeIndicators(nodes),
  ]);
  return { parent, page, pageSize: AMUX_EXECUTION_PAGE_SIZE, total,
    items: nodes.map((node, index) => ({ type: "node" as const,
      id: node.id, title: titles[index], level: node.level,
      parentId: node.parentId, state: node.state,
      assessment: indicators.get(node.id)?.assessment ?? null,
      progress: indicators.get(node.id)?.progress ?? { done: 0, total: 0 } })) };
}

export async function readAmuxExecutionTaskDetail(taskId: string) {
  const card = await prisma.amuxWorkItem.findUnique({ where: { id: taskId },
    select: { ...cardSelect, description: true, executionBrief: true,
      createdAt: true, effortPoints: true, estimatedCostMicrousd: true,
      v4BodyCiphertext: true, v4BodyKeyId: true, v4BodyKeyVersion: true,
      v4BodyDigest: true, v4BodyDigestKeyId: true,
      v4BriefCiphertext: true, v4BriefKeyId: true, v4BriefKeyVersion: true,
      v4BriefDigestKeyId: true, revision: true,
      dependencies: { select: { dependency: { select: { id: true,
        sourceKey: true, status: true } } } },
      dependents: { select: { task: { select: { id: true,
        sourceKey: true, status: true } } } },
      executionAttempts: { orderBy: { startedAt: "desc" as const }, take: 20,
        select: { id: true, worker: true, attemptNumber: true,
          startedAt: true, endedAt: true, outcome: true, toStatus: true,
          reason: true, reservedCostMicrousd: true,
          settledCostMicrousd: true, costConfirmed: true } },
      humanEscalations: { where: { status: { in: ["open", "acknowledged"] } },
        orderBy: { createdAt: "desc" as const }, take: 10,
        select: { id: true, reason: true, specialty: true,
          status: true, createdAt: true } },
      portfolioScoreSnapshots: { orderBy: { computedAt: "desc" as const },
        take: 1, select: { taskRevision: true,
          scoreTotal: true, components: true,
          evidenceAsOf: true, activeStaleAt: true, baselineStaleAt: true } },
      engineeringAgentRuns: { orderBy: { startedAt: "desc" as const },
        take: 10, select: { id: true, baseSha: true, status: true,
          outcome: true, startedAt: true, bindings: { orderBy: {
            createdAt: "desc" as const }, take: 10,
            select: { id: true, prNumber: true, headSha: true,
              verifiedHeadSha: true, state: true, supersededAt: true,
              createdAt: true } } } },
    } });
  if (!card) return null;
  const [summary] = await cardSummaries([card]);
  const [usage, reviews, result, feedbackAttempts, feedbackUsage, feedbackDecisions,
    feedbackObservations, sourceApproval] = await Promise.all([
    prisma.amuxCliUsageEvent.findMany({ where: { taskId },
      orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, attemptId: true, provider: true,
        actualModelId: true, selectedModelId: true, status: true,
        completeness: true, inputTokens: true, outputTokens: true,
        projectedApiCostMicrousd: true, actualApiCostMicrousd: true,
        startedAt: true } }),
    prisma.amuxReviewProposal.findMany({ where: { taskId },
      orderBy: { issuedAt: "desc" }, take: 10,
      select: { escalationId: true, taskRevision: true, outcome: true,
        reviewPrNumber: true, reviewBaseSha: true, reviewHeadSha: true,
        reviewDiffDigest: true, issuedAt: true } }),
    card.sourceSystem === "admin-idea-v4" ?
      readAmuxV22TaskResultForOwner(taskId).catch(() => null) :
      Promise.resolve(null),
    card.cardType === "task" ? prisma.amuxExecutionAttempt.findMany({
      where: { taskId }, select: { id: true, startedAt: true, endedAt: true,
        outcome: true, settledCostMicrousd: true, costConfirmed: true },
    }) : [],
    card.cardType === "task" ? prisma.amuxCliUsageEvent.findMany({
      where: { taskId }, select: { attemptId: true, completeness: true,
        inputTokens: true, outputTokens: true, cacheReadInputTokens: true,
        cacheCreationInputTokens: true, projectedApiCostMicrousd: true,
        actualApiCostMicrousd: true },
    }) : [],
    card.cardType === "task" ? prisma.amuxReviewDecision.findMany({
      where: { proposal: { taskId } }, select: { id: true, outcome: true,
        decidedAt: true, proposal: { select: { taskRevision: true } } },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    }) : [],
    card.cardType === "task" ? prisma.adminAuditLog.findMany({ where: {
      action: AMUX_V22_OUTCOME_ACTION, targetType: AMUX_V22_OUTCOME_TARGET,
      targetId: taskId, actorUserId: { not: null },
    }, select: { metadata: true } }) : [],
    card.cardType === "task" && card.v4SourceApprovalId ?
      prisma.amuxIdeaUnitDecision.findUnique({ where: {
        id: card.v4SourceApprovalId }, select: { state: true, action: true,
        registeredWorkItemId: true, confirmationSnapshot: true } }) :
      Promise.resolve(null),
  ]);
  let body: string | null = card.description;
  let brief: string | null = card.executionBrief;
  if (card.sourceSystem === "admin-idea-v4") {
    body = null; brief = null;
    const ideaId = ideaIdFromSnapshot(card.sourceSnapshot);
    const read = async (purpose: "card_body" | "card_brief",
      ciphertext: Uint8Array | null, keyId: string | null,
      keyVersion: number | null, digest: string | null,
      digestKeyId: string | null): Promise<string | null> => {
      if (!ideaId || !ciphertext || !keyId || !keyVersion || !digest ||
          !digestKeyId) return null;
      try {
        const keys = await loadAmuxContentUnitKeys({ ideaId,
          purpose, subjectId: taskId });
        let plain: Buffer | null = null;
        try {
          plain = openAmuxContent({ ciphertext: Buffer.from(ciphertext),
            keyId, keyVersion }, purpose, taskId, keys);
          return verifyAmuxContentDigest(plain, purpose, taskId,
          digest, digestKeyId, keys) ? plain.toString("utf8") : null; }
        finally { plain?.fill(0); keys.masterKey.fill(0); }
      } catch { return null; }
    };
    [body, brief] = await Promise.all([
      read("card_body", card.v4BodyCiphertext, card.v4BodyKeyId,
        card.v4BodyKeyVersion, card.v4BodyDigest, card.v4BodyDigestKeyId),
      read("card_brief", card.v4BriefCiphertext, card.v4BriefKeyId,
        card.v4BriefKeyVersion, card.v4BriefDigest, card.v4BriefDigestKeyId),
    ]);
  }
  const currentDecision = feedbackDecisions.find((decision) =>
    decision.proposal.taskRevision + 1 === card.revision);
  return { ...summary, revision: card.revision, body, brief,
    outcomeWriteEnabled: amuxV22OutcomeWriteEnabled(
      process.env[AMUX_V22_OUTCOME_WRITE_ENV]) &&
      card.sourceSystem === "admin-idea-v4" &&
      ((currentDecision?.outcome === "approve" && card.status === "done") ||
        (currentDecision?.outcome === "retry" && card.status === "todo") ||
        (currentDecision?.outcome === "block" && card.status === "blocked")),
    feedback: card.cardType === "task" ? projectAmuxTaskFeedback({
      id: card.id, revision: card.revision, status: card.status,
      createdAt: card.createdAt,
      effortPoints: card.effortPoints,
      estimatedCostMicrousd: card.estimatedCostMicrousd,
      approvedCeilingMicrousd: sourceApproval?.state === "consumed" &&
        sourceApproval.action === "register_card" &&
        sourceApproval.registeredWorkItemId === card.id ?
        readAmuxV4ApprovedCeiling(sourceApproval.confirmationSnapshot) : null,
      attempts: feedbackAttempts, usage: feedbackUsage,
      decisions: feedbackDecisions.map((decision) => ({ id: decision.id,
        outcome: decision.outcome, decidedAt: decision.decidedAt })),
      observations: feedbackObservations.flatMap((row) => {
        const item = readAmuxV22ObservationMetadata(row.metadata);
        return item ? [item] : [];
      }),
    }) : null,
    v4EvidenceDigests: card.sourceSystem === "admin-idea-v4" ? {
      title: card.v4TitleDigest, body: card.v4BodyDigest,
      brief: card.v4BriefDigest } : null,
    result: result ? { attemptId: result.attemptId, state: result.state,
      createdAt: result.createdAt,
      text: result.state === "available" ? result.text : null,
      sha256: result.state === "available" ?
        createHash("sha256").update(result.text).digest("hex") : null,
      patch: result.patch?.state === "available" ? {
        state: "available" as const, baseSha: result.patch.baseSha,
        sha256: result.patch.sha256,
      } : result.patch?.state === "purged" ?
        { state: "purged" as const } : null } : null,
    dependencies: card.dependencies.map((edge) => edge.dependency),
    dependents: card.dependents.map((edge) => edge.task),
    attempts: card.executionAttempts.map((attempt) => ({ ...attempt,
      reason: normalizeAmuxUntrustedReason(attempt.reason),
      startedAt: attempt.startedAt.toISOString(),
      endedAt: attempt.endedAt?.toISOString() ?? null,
      reservedCostMicrousd: attempt.reservedCostMicrousd.toString(),
      settledCostMicrousd: attempt.settledCostMicrousd?.toString() ?? null })),
    escalations: card.humanEscalations.map((item) => ({ ...item,
      reason: storedAmuxEscalationReasonCode(item.reason, item.specialty),
      createdAt: item.createdAt.toISOString() })),
    score: card.portfolioScoreSnapshots[0] ? {
      ...card.portfolioScoreSnapshots[0],
      activeFresh: card.portfolioScoreSnapshots[0].taskRevision ===
        card.revision && card.portfolioScoreSnapshots[0].activeStaleAt.getTime() >
        new Date().getTime(),
      evidenceAsOf: card.portfolioScoreSnapshots[0].evidenceAsOf.toISOString(),
      activeStaleAt: card.portfolioScoreSnapshots[0].activeStaleAt.toISOString(),
      baselineStaleAt: card.portfolioScoreSnapshots[0].baselineStaleAt.toISOString(),
    } : null,
    usage: usage.map((item) => ({ ...item,
      startedAt: item.startedAt.toISOString(),
      inputTokens: item.inputTokens?.toString() ?? null,
      outputTokens: item.outputTokens?.toString() ?? null,
      projectedApiCostMicrousd: item.projectedApiCostMicrousd?.toString() ?? null,
      actualApiCostMicrousd: item.actualApiCostMicrousd?.toString() ?? null })),
    reviews: reviews.map((item) => ({ ...item,
      currentRevision: item.taskRevision === card.revision,
      issuedAt: item.issuedAt.toISOString() })),
    publications: card.engineeringAgentRuns.map((run) => ({
      id: run.id, baseSha: run.baseSha, status: run.status,
      outcome: run.outcome, startedAt: run.startedAt.toISOString(),
      bindings: run.bindings.map((binding) => ({ ...binding,
        supersededAt: binding.supersededAt?.toISOString() ?? null,
        createdAt: binding.createdAt.toISOString() })),
    })),
  };
}

/** Owner-only, on-demand hierarchy rollup. A large result is explicitly
 * incomplete instead of silently summing a page of children. */
export async function readAmuxExecutionFeedback(parent: {
  kind: "node" | "story"; id: string;
}) {
  let featureIds: string[] = [];
  if (parent.kind === "node") {
    const node = await prisma.amuxPortfolioNode.findUnique({ where: { id: parent.id },
      select: { state: true } });
    if (!node || node.state !== "active") return null;
    const descendants = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE descendants("id", "level", "depth") AS (
        SELECT "id", "level", 0 FROM "AmuxPortfolioNode"
        WHERE "id" = ${parent.id} AND "state" = 'active'
        UNION ALL
        SELECT child."id", child."level", d."depth" + 1
        FROM descendants d JOIN "AmuxPortfolioNode" child
          ON child."parentId" = d."id"
        WHERE child."state" = 'active' AND d."depth" < 2
      ) SELECT "id" FROM descendants WHERE "level" = 'feature'
    `;
    featureIds = descendants.map((row) => row.id);
  } else {
    const story = await prisma.amuxWorkItem.findUnique({ where: { id: parent.id },
      select: { cardType: true, archivedAt: true } });
    if (!story || story.cardType !== "story" || story.archivedAt) return null;
  }
  const where = amuxFeedbackTaskWhere(parent, featureIds);
  const cards = await prisma.amuxWorkItem.findMany({ where,
    take: 501, orderBy: { id: "asc" }, select: { id: true, revision: true,
      status: true,
      createdAt: true, effortPoints: true, estimatedCostMicrousd: true,
      v4SourceApprovalId: true } });
  if (cards.length > 500) return { parent, complete: false,
    reason: "task_limit", rollup: null };
  const ids = cards.map((card) => card.id);
  const [attempts, usage, decisions, observations, approvals] = ids.length ? await Promise.all([
    prisma.amuxExecutionAttempt.findMany({ where: { taskId: { in: ids } },
      select: { taskId: true, id: true, startedAt: true, endedAt: true,
        outcome: true, settledCostMicrousd: true, costConfirmed: true } }),
    prisma.amuxCliUsageEvent.findMany({ where: { taskId: { in: ids } },
      select: { taskId: true, attemptId: true, completeness: true,
        inputTokens: true, outputTokens: true, cacheReadInputTokens: true,
        cacheCreationInputTokens: true, projectedApiCostMicrousd: true,
        actualApiCostMicrousd: true } }),
    prisma.amuxReviewDecision.findMany({ where: { proposal: { taskId: { in: ids } } },
      select: { id: true, outcome: true, decidedAt: true,
        proposal: { select: { taskId: true } } } }),
    prisma.adminAuditLog.findMany({ where: {
      action: AMUX_V22_OUTCOME_ACTION, targetType: AMUX_V22_OUTCOME_TARGET,
      targetId: { in: ids }, actorUserId: { not: null },
    }, select: { targetId: true, metadata: true } }),
    prisma.amuxIdeaUnitDecision.findMany({ where: {
      id: { in: cards.flatMap((card) => card.v4SourceApprovalId ?
        [card.v4SourceApprovalId] : []) }, state: "consumed",
      action: "register_card",
    }, select: { id: true, registeredWorkItemId: true,
      confirmationSnapshot: true } }),
  ]) : [[], [], [], [], []];
  const feedback = cards.map((card) => projectAmuxTaskFeedback({
    ...card, approvedCeilingMicrousd: readAmuxV4ApprovedCeiling(
      approvals.find((row) => row.id === card.v4SourceApprovalId &&
        row.registeredWorkItemId === card.id)?.confirmationSnapshot),
    attempts: attempts.filter((row) => row.taskId === card.id),
    usage: usage.filter((row) => row.taskId === card.id),
    decisions: decisions.filter((row) => row.proposal.taskId === card.id),
    observations: observations.filter((row) => row.targetId === card.id)
      .flatMap((row) => {
        const item = readAmuxV22ObservationMetadata(row.metadata);
        return item ? [item] : [];
      }),
  }));
  return { parent, complete: true, reason: null,
    rollup: rollupAmuxTaskFeedback(feedback) };
}
