import "server-only";

import { createHash } from "node:crypto";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import { AMUX_V22_OUTCOME_ACTION, AMUX_V22_OUTCOME_TARGET,
  AMUX_V22_OUTCOME_WRITE_ENV, amuxV22OutcomeWriteEnabled,
  inspectAmuxV22OutcomeRequest, readAmuxV22ObservationMetadata } from
  "./v22OutcomeObservationCore.ts";

export class AmuxV22OutcomeRefusal extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
  }
}

export async function readAmuxV22OutcomeReceipt(taskId: string, requestId: string) {
  const row = await prisma.adminAuditLog.findFirst({ where: {
    action: AMUX_V22_OUTCOME_ACTION, targetType: AMUX_V22_OUTCOME_TARGET,
    targetId: taskId, metadata: { path: ["requestId"], equals: requestId },
  }, select: { id: true, metadata: true }, orderBy: { createdAt: "desc" } });
  return row && readAmuxV22ObservationMetadata(row.metadata) ?
    { auditLogId: row.id, observation: readAmuxV22ObservationMetadata(row.metadata) } : null;
}

export async function recordAmuxV22Outcome(input: {
  session: Session; request: Request; body: unknown;
}) {
  if (!input.session.user?.id || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner" ||
      !hasValidMutationOrigin(input.request))
    throw new AmuxV22OutcomeRefusal("forbidden", 403);
  await assertRecentAdminAuthentication(input.session);
  if (!amuxV22OutcomeWriteEnabled(process.env[AMUX_V22_OUTCOME_WRITE_ENV]))
    throw new AmuxV22OutcomeRefusal("outcome_write_disabled", 503);
  const parsed = inspectAmuxV22OutcomeRequest(input.body);
  if (!parsed) throw new AmuxV22OutcomeRefusal("invalid_request", 400);
  const digest = createHash("sha256").update(JSON.stringify({
    version: parsed.version, requestId: parsed.requestId,
    taskId: parsed.taskId, revision: parsed.revision,
    kind: parsed.kind, outcome: parsed.outcome,
    evidenceDigest: parsed.evidenceDigest,
    findingCount: parsed.findingCount,
    revisedEffortPoints: parsed.revisedEffortPoints,
    revisedCostMicrousd: parsed.revisedCostMicrousd,
    reasonCode: parsed.reasonCode,
  })).digest("hex");
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${parsed.taskId} FOR UPDATE
    `;
    if (!locked[0]) throw new AmuxV22OutcomeRefusal("not_found", 404);
    const prior = await tx.adminAuditLog.findFirst({ where: {
      action: AMUX_V22_OUTCOME_ACTION, targetType: AMUX_V22_OUTCOME_TARGET,
      targetId: parsed.taskId,
      metadata: { path: ["requestId"], equals: parsed.requestId },
    }, select: { id: true, metadata: true } });
    if (prior) {
      const metadata = prior.metadata as Record<string, unknown> | null;
      if (metadata?.requestDigest !== digest)
        throw new AmuxV22OutcomeRefusal("request_id_conflict");
      return { auditLogId: prior.id, replay: true };
    }
    const task = await tx.amuxWorkItem.findUnique({ where: { id: parsed.taskId },
      select: { sourceSystem: true, cardType: true, status: true,
        revision: true } });
    if (!task || task.sourceSystem !== "admin-idea-v4" ||
        task.cardType !== "task")
      throw new AmuxV22OutcomeRefusal("not_found", 404);
    if (task.revision !== parsed.revision)
      throw new AmuxV22OutcomeRefusal("task_state_changed");
    const decision = await tx.amuxReviewDecision.findFirst({ where: {
      proposal: { taskId: parsed.taskId,
        taskRevision: parsed.revision - 1 },
    }, select: { id: true, outcome: true },
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }] });
    const expectedStatus = decision?.outcome === "approve" ? "done" :
      decision?.outcome === "retry" ? "todo" :
      decision?.outcome === "block" ? "blocked" : null;
    if (!decision || !expectedStatus || task.status !== expectedStatus)
      throw new AmuxV22OutcomeRefusal("owner_decision_missing");
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock[0]) throw new AmuxV22OutcomeRefusal("clock_unavailable", 503);
    const observedAt = clock[0].now.toISOString();
    const auditLogId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: AMUX_V22_OUTCOME_ACTION,
      targetType: AMUX_V22_OUTCOME_TARGET, targetId: parsed.taskId,
      summary: "AMUX v22 owner outcome observation",
      metadata: { requestId: parsed.requestId, requestDigest: digest,
        taskRevision: parsed.revision, kind: parsed.kind,
        outcome: parsed.outcome, evidenceDigest: parsed.evidenceDigest,
        findingCount: parsed.findingCount,
        revisedEffortPoints: parsed.revisedEffortPoints,
        revisedCostMicrousd: parsed.revisedCostMicrousd,
        reasonCode: parsed.reasonCode,
        observedAt, ownerDecisionId: decision.id } });
    return { auditLogId, replay: false };
  });
}
