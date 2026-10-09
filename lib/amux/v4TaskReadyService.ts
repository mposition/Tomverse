import "server-only";

import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { findOpenAmuxOrchestratorHalt } from "./orchestratorHaltStore.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import type { AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { calculateCurrentApprovedAmuxV4TaskCost } from
  "./v4TaskCostCatalogApprovalService.ts";
import { checkV4TaskApprovedCeiling } from "./v4TaskCostCeilingCore.ts";
import { getConfiguredAmuxWorkerCatalog } from "./routing.ts";
import { evaluateAmuxV4TaskReady, type AmuxV4TaskReadyFacts } from
  "./v4TaskReadyCore.ts";

const TASK_ID = /^[A-Za-z0-9:_-]{8,128}$/;
const IDEA_ID = /^[A-Za-z0-9_-]{8,80}$/;

export class AmuxV4TaskReadyError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "unavailable") {
    super(code);
    this.name = "AmuxV4TaskReadyError";
  }
}

function ownerId(session: Session) {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new AmuxV4TaskReadyError("forbidden");
  }
  return id;
}

export function parseAmuxV4TaskReceipt(raw: Prisma.JsonValue | null):
  AmuxIdeaUnitConfirmationSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      raw.action !== "register_card" ||
      !raw.card || typeof raw.card !== "object" || Array.isArray(raw.card) ||
      raw.card.cardType !== "task" ||
      !raw.card.normalizedBody || typeof raw.card.normalizedBody !== "object" ||
      Array.isArray(raw.card.normalizedBody) ||
      typeof raw.card.normalizedBody.digest !== "string" ||
      typeof raw.card.normalizedBody.keyId !== "string" ||
      !raw.card.task || typeof raw.card.task !== "object" ||
      Array.isArray(raw.card.task) ||
      typeof raw.card.task.role !== "string" ||
      typeof raw.card.task.grade !== "string" ||
      !raw.card.task.brief || typeof raw.card.task.brief !== "object" ||
      Array.isArray(raw.card.task.brief) ||
      typeof raw.card.task.brief.digest !== "string" ||
      typeof raw.card.task.brief.keyId !== "string" ||
      !("parentStory" in raw.card) ||
      (raw.card.parentStory !== null &&
        (typeof raw.card.parentStory !== "object" ||
          Array.isArray(raw.card.parentStory) ||
          typeof raw.card.parentStory.id !== "string" ||
          !Number.isSafeInteger(raw.card.parentStory.revision) ||
          !raw.card.parentStory.content ||
          typeof raw.card.parentStory.content !== "object" ||
          Array.isArray(raw.card.parentStory.content) ||
          typeof raw.card.parentStory.content.digest !== "string" ||
          typeof raw.card.parentStory.content.keyId !== "string")) ||
      !raw.card.task.costReceipt ||
      typeof raw.card.task.costReceipt !== "object" ||
      Array.isArray(raw.card.task.costReceipt) ||
      !Array.isArray(raw.card.dependencies) ||
      !raw.card.dependencies.every((item) => item &&
        typeof item === "object" && !Array.isArray(item) &&
        typeof item.id === "string") ||
      !Array.isArray(raw.hierarchy) || raw.hierarchy.length !== 3 ||
      !raw.hierarchy.every((item) => item && typeof item === "object" &&
        !Array.isArray(item) && typeof item.id === "string" &&
        typeof item.approvedDecisionId === "string" &&
        Number.isSafeInteger(item.revision) &&
        item.content && typeof item.content === "object" &&
        !Array.isArray(item.content) &&
        typeof item.content.digest === "string" &&
        typeof item.content.keyId === "string")) return null;
  return raw as unknown as AmuxIdeaUnitConfirmationSnapshot;
}

function validScope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return typeof body.problem === "string" && body.problem.trim().length > 0 &&
    Array.isArray(body.scopeIn) && body.scopeIn.length > 0 &&
    body.scopeIn.every((item) => typeof item === "string" && item.trim()) &&
    Array.isArray(body.scopeOut) &&
    body.scopeOut.every((item) => typeof item === "string" && item.trim()) &&
    Array.isArray(body.completionCriteria) &&
    body.completionCriteria.length > 0 &&
    body.completionCriteria.every((item) =>
      typeof item === "string" && item.trim());
}

async function currentPath(tx: Prisma.TransactionClient, card: {
  parentFeatureNodeId: string | null; parentStoryCardId: string | null;
}, snapshot: AmuxIdeaUnitConfirmationSnapshot | null): Promise<boolean> {
  const path = snapshot?.hierarchy;
  if (!card.parentFeatureNodeId || !path || path.length !== 3 ||
      path[2]?.id !== card.parentFeatureNodeId ||
      snapshot?.card?.featureNodeId !== card.parentFeatureNodeId ||
      (snapshot.card.parentStory?.id ?? null) !== card.parentStoryCardId) {
    return false;
  }
  const rows = await tx.amuxPortfolioNode.findMany({
    where: { id: { in: path.map((item) => item.id) } },
    select: { id: true, level: true, parentId: true, state: true,
      revision: true, contentDigest: true, contentDigestKeyId: true },
  });
  const nodes = new Map(rows.map((item) => [item.id, item]));
  for (const [index, approved] of path.entries()) {
    const node = nodes.get(approved.id);
    if (!node || node.state !== "active" ||
        node.level !== (["initiative", "epic", "feature"] as const)[index] ||
        node.parentId !== (index ? path[index - 1]!.id : null) ||
        node.revision !== approved.revision ||
        node.contentDigest !== approved.content.digest ||
        node.contentDigestKeyId !== approved.content.keyId) return false;
    const revision = await tx.amuxPortfolioNodeRevision.findUnique({
      where: { nodeId_revision: { nodeId: node.id, revision: node.revision } },
      select: { decisionId: true },
    });
    const decision = revision ? await tx.amuxIdeaUnitDecision.findUnique({
      where: { id: revision.decisionId },
      select: { state: true, action: true, resolvedNodeId: true },
    }) : null;
    if (revision?.decisionId !== approved.approvedDecisionId ||
        decision?.state !== "consumed" || decision.action !== "create_node" ||
        decision.resolvedNodeId !== node.id) return false;
  }
  if (card.parentStoryCardId) {
    const story = await tx.amuxWorkItem.findUnique({
      where: { id: card.parentStoryCardId },
      select: { id: true, sourceSystem: true, cardType: true, status: true,
        archivedAt: true, parentFeatureNodeId: true, revision: true,
        v4TitleDigest: true, v4TitleDigestKeyId: true,
        v4SourceApprovalId: true },
    });
    const approved = snapshot.card?.parentStory;
    const decision = story?.v4SourceApprovalId ?
      await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: story.v4SourceApprovalId },
        select: { state: true, action: true, registeredWorkItemId: true },
      }) : null;
    if (!story || !approved || story.sourceSystem !== "admin-idea-v4" ||
        story.cardType !== "story" || story.status !== "backlog" ||
        story.archivedAt !== null ||
        story.parentFeatureNodeId !== card.parentFeatureNodeId ||
        story.revision !== approved.revision ||
        story.v4TitleDigest !== approved.content.digest ||
        story.v4TitleDigestKeyId !== approved.content.keyId ||
        decision?.state !== "consumed" || decision.action !== "register_card" ||
        decision.registeredWorkItemId !== story.id) return false;
  }
  return true;
}

/** Key material is loaded before a transaction; promotion re-reads every
 * mutable fact under the queue lock and never treats this lookup as evidence. */
export async function loadAmuxV4TaskReadyContext(taskId: string) {
  if (!TASK_ID.test(taskId)) throw new AmuxV4TaskReadyError("not_found");
  const initial = await prisma.amuxWorkItem.findUnique({
    where: { id: taskId }, select: { id: true, sourceSystem: true,
      cardType: true, sourceSnapshot: true },
  });
  if (!initial || initial.sourceSystem !== "admin-idea-v4" ||
      initial.cardType !== "task" ||
      !initial.sourceSnapshot || typeof initial.sourceSnapshot !== "object" ||
      Array.isArray(initial.sourceSnapshot) ||
      !IDEA_ID.test(String(initial.sourceSnapshot.ideaId ?? ""))) {
    throw new AmuxV4TaskReadyError("not_found");
  }
  const ideaId = String(initial.sourceSnapshot.ideaId);
  const keys = await loadAmuxContentKeyRing([
    { ideaId, purpose: "card_body", subjectId: taskId },
    { ideaId, purpose: "card_brief", subjectId: taskId },
  ]);
  return { ideaId, keys };
}

export async function evaluateAmuxV4TaskReadyInTransaction(
  tx: Prisma.TransactionClient, taskId: string,
  context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>>,
  expectedActorUserId: string | null,
  expectedStatus: "backlog" | "todo" = "backlog",
) {
    const { ideaId, keys } = context;
    const card = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
      select: { id: true, sourceSystem: true, sourceSnapshot: true,
        sourceDigest: true, cardType: true, status: true, archivedAt: true,
        owner: true, claimedAt: true, revision: true,
        parentFeatureNodeId: true, parentStoryCardId: true,
        v4SourceApprovalId: true, v4BodyCiphertext: true,
        v4BodyKeyId: true, v4BodyKeyVersion: true,
        v4BodyDigest: true, v4BodyDigestKeyId: true,
        v4BriefCiphertext: true, v4BriefKeyId: true,
        v4BriefKeyVersion: true, v4BriefDigest: true,
        v4BriefDigestKeyId: true, taskRole: true, executionGrade: true,
        dependencies: { select: { dependencyId: true, dependency: {
          select: { id: true, sourceSystem: true, cardType: true,
            status: true, v4TerminalAt: true, v4SourceApprovalId: true },
        } } },
      },
    });
    if (!card || card.sourceSystem !== "admin-idea-v4" ||
        card.cardType !== "task" ||
        !card.sourceSnapshot || typeof card.sourceSnapshot !== "object" ||
        Array.isArray(card.sourceSnapshot) ||
        card.sourceSnapshot.ideaId !== ideaId) {
      throw new AmuxV4TaskReadyError("not_found");
    }
    const decision = card.v4SourceApprovalId ?
      await tx.amuxIdeaUnitDecision.findUnique({
        where: { id: card.v4SourceApprovalId },
        select: { id: true, action: true, state: true, actorUserId: true,
          ideaId: true, draftUnitId: true, unitDigest: true,
          unitDigestKeyId: true, confirmationDigest: true,
          confirmationSnapshot: true,
          finalAuditLogId: true, registeredWorkItemId: true },
      }) : null;
    const snapshot = parseAmuxV4TaskReceipt(decision?.confirmationSnapshot ?? null);
    const audit = decision?.finalAuditLogId ? await tx.adminAuditLog.findUnique({
      where: { id: decision.finalAuditLogId },
      select: { action: true, actorUserId: true, targetId: true,
        targetType: true, entryHash: true },
    }) : null;
    const sourceApprovalValid = decision?.state === "consumed" &&
      decision.action === "register_card" &&
      (expectedActorUserId === null || decision.actorUserId === expectedActorUserId) &&
      decision.ideaId === ideaId &&
      decision.registeredWorkItemId === card.id &&
      card.sourceSnapshot.approvalId === decision.id &&
      card.sourceDigest === decision.unitDigest &&
      snapshot?.decisionId === decision.id &&
      snapshot.ideaId === ideaId && snapshot.actorUserId === decision.actorUserId &&
      snapshot.draftUnitId === decision.draftUnitId &&
      snapshot.card?.cardType === "task" &&
      snapshot.card.normalizedBody.digest === decision.unitDigest &&
      snapshot.card.normalizedBody.keyId === decision.unitDigestKeyId &&
      /^[a-f0-9]{64}$/.test(snapshot.card.task?.brief.digest ?? "") &&
      snapshot.card.task?.role === card.taskRole &&
      snapshot.card.task.grade === card.executionGrade &&
      audit?.entryHash !== null && audit?.entryHash !== undefined &&
      audit.action === "amux.v4.unit.consume" &&
      audit.actorUserId === decision.actorUserId && audit.targetId === decision.id &&
      audit.targetType === "AmuxIdeaUnitDecision";
    let briefAndScopeVerified = false;
    if (card.v4BodyCiphertext && card.v4BodyKeyId && card.v4BodyKeyVersion &&
        card.v4BodyDigest && card.v4BodyDigestKeyId &&
        card.v4BriefCiphertext && card.v4BriefKeyId && card.v4BriefKeyVersion &&
        card.v4BriefDigest && card.v4BriefDigestKeyId) {
      let body: Buffer | null = null;
      let brief: Buffer | null = null;
      try {
        body = openAmuxContent({ ciphertext: Buffer.from(card.v4BodyCiphertext),
          keyId: card.v4BodyKeyId, keyVersion: card.v4BodyKeyVersion },
          "card_body", card.id, keys);
        brief = openAmuxContent({ ciphertext: Buffer.from(card.v4BriefCiphertext),
          keyId: card.v4BriefKeyId, keyVersion: card.v4BriefKeyVersion },
          "card_brief", card.id, keys);
        briefAndScopeVerified = verifyAmuxContentDigest(body, "card_body", card.id,
          card.v4BodyDigest, card.v4BodyDigestKeyId, keys) &&
          verifyAmuxContentDigest(brief, "card_brief", card.id,
            card.v4BriefDigest, card.v4BriefDigestKeyId, keys) &&
          validScope(JSON.parse(body.toString("utf8"))) &&
          brief.toString("utf8").trim().length > 0;
      } catch { briefAndScopeVerified = false; }
      finally { body?.fill(0); brief?.fill(0); }
    }
    const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now`;
    const now = nowRows[0]?.now ?? new Date();
    let cost: AmuxV4TaskReadyFacts["cost"] = "hold";
    let workerNames: string[] = [];
    if (snapshot?.card?.task && card.taskRole && card.executionGrade) {
      const role = card.taskRole;
      try {
        const current = await calculateCurrentApprovedAmuxV4TaskCost(tx,
          role, card.executionGrade);
        cost = checkV4TaskApprovedCeiling(
          snapshot.card.task.costReceipt, { ok: true,
            receipt: current.receipt }).decision;
        if (cost === "allow") {
          const configured = getConfiguredAmuxWorkerCatalog();
          workerNames = current.receipt.routes.filter((route) =>
            configured?.some((worker) =>
              worker.worker_name === route.workerName &&
              worker.provider === route.provider.toLowerCase() &&
              worker.model === route.modelId &&
              worker.routing_roles.includes(role) &&
              !worker.archived && !worker.paused && !worker.isolated &&
              !worker.blocked)).map((route) => route.workerName);
        }
      } catch { cost = "hold"; }
    }
    const workers = workerNames.length ? await tx.amuxWorkerRuntime.findMany({
      where: { workerName: { in: workerNames }, dispatchReady: true,
        status: { in: ["idle", "busy"] }, leaseExpiresAt: { gt: now } },
      select: { workerName: true },
    }) : [];
    const approvals = await tx.amuxIdeaUnitDecision.findMany({
      where: { id: { in: card.dependencies.map((entry) =>
        entry.dependency.v4SourceApprovalId).filter((id): id is string => !!id) } },
      select: { id: true, state: true, action: true, registeredWorkItemId: true },
    });
    const approvedDeps = new Map(approvals.map((item) => [item.id, item]));
    const dependencies = card.dependencies.map((edge) => {
      const dependency = edge.dependency;
      const approval = dependency.v4SourceApprovalId ?
        approvedDeps.get(dependency.v4SourceApprovalId) : null;
      return { id: edge.dependencyId,
        approvedTask: dependency.sourceSystem === "admin-idea-v4" &&
          dependency.cardType === "task" && approval?.state === "consumed" &&
          approval.action === "register_card" &&
          approval.registeredWorkItemId === dependency.id,
        status: dependency.status, terminal: dependency.v4TerminalAt !== null };
    });
    const halted = await findOpenAmuxOrchestratorHalt(tx);
    const approvedIds = snapshot?.card?.dependencies;
    const facts: AmuxV4TaskReadyFacts = {
      card: { sourceSystem: card.sourceSystem, cardType: card.cardType,
        status: card.status, archived: card.archivedAt !== null,
        owner: card.owner, claimed: card.claimedAt !== null,
        role: card.taskRole, grade: card.executionGrade,
        briefAndScopeVerified },
      sourceApprovalValid,
      parentPathCurrent: await currentPath(tx, card, snapshot),
      approvedDependencyIds: Array.isArray(approvedIds) ?
        approvedIds.map((item) => item.id) : null,
      dependencies, cost, compatibleWorkerCount: workers.length,
      orchestratorHalted: halted !== null,
    };
    return { taskId, taskRevision: card.revision, observedAt: now.toISOString(),
      sourceApprovalId: sourceApprovalValid ? decision.id : null,
      sourceApprovalDigest: sourceApprovalValid ? decision.confirmationDigest : null,
      briefDigest: card.v4BriefDigest,
      parentFeatureNodeId: card.parentFeatureNodeId,
      parentStoryCardId: card.parentStoryCardId,
      ...evaluateAmuxV4TaskReady(facts, expectedStatus) };
}

/** Admin-only, repeatable-read observation. This response is not promotion
 * authority; the writer calls the same evaluator in its own transaction. */
export async function readAmuxV4TaskReady(session: Session, taskId: string) {
  const actorUserId = ownerId(session);
  const context = await loadAmuxV4TaskReadyContext(taskId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
    return evaluateAmuxV4TaskReadyInTransaction(tx, taskId, context,
      actorUserId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 2_000, timeout: 8_000 });
}
