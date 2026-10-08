import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import {
  AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
  AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
} from "@/lib/adminAuditSystemActors";
import { matchesInitialPlanSystemAudit } from "./ideaInitialPlanAuditCore.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";
import { loadCurrentAmuxContentKeys } from "./ideaKeyConfig.ts";
import { amuxContentKeyRing, loadAmuxContentUnitKeys } from "./ideaKeyStore.ts";
import {
  AMUX_V4_INITIAL_PLAN_WRITE_ENV,
  initialPlanWritePermitted,
} from "./ideaInitialSourcePlanCore.ts";
import { createInitialIdeaOnlySourcePlan, InitialSourcePlanError } from "./ideaInitialSourcePlanService.ts";

export class InitialPlanAccessError extends Error {
  constructor(readonly code: "not_found" | "plan_disabled" | "integrity_unavailable" |
    "outcome_unknown", readonly status: number,
    readonly readBack?: "committed" | "partial" | "absent" | "unavailable") {
    super(code);
    this.name = "InitialPlanAccessError";
  }
}

function ownerId(session: Session): string {
  const id = session.user?.id;
  if (!id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new InitialPlanAccessError("not_found", 404);
  }
  return id;
}

/** Metadata only. A missing idea is indistinguishable from one owned by someone else. */
export async function readInitialIdeaSourcePlan(session: Session, ideaId: string): Promise<
  { ideaId: string; status: "committed" | "absent" | "partial"; revisionId?: string }
> {
  const actorUserId = ownerId(session);
  const idea = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: ideaId, actorUserId },
    select: { currentSourcePlanRevisionId: true },
  });
  if (!idea) throw new InitialPlanAccessError("not_found", 404);
  const revisionId = idea.currentSourcePlanRevisionId;
  if (!revisionId) return { ideaId, status: "absent" };
  const plan = await prisma.amuxIdeaSourcePlanRevision.findFirst({
    where: { id: revisionId, ideaId, actorUserId },
    select: { id: true, state: true, creationAuditLogId: true, manifestDigest: true,
      startChunkIndex: true },
  });
  if (!plan) return { ideaId, status: "partial" };
  const chunk = await prisma.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: plan.startChunkIndex } },
    select: { actorUserId: true, sourcePlanRevisionId: true,
      planStartChunkIndex: true, revisionChunkIndex: true },
  });
  const audit = await prisma.adminAuditLog.findFirst({
    where: { id: plan.creationAuditLogId, action: AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
      targetType: AMUX_V4_INITIAL_SOURCE_PLAN_TARGET, targetId: plan.id,
      actorUserId: null },
    select: { action: true, targetType: true, actorUserId: true, actorEmail: true,
      ipAddress: true, userAgent: true, metadata: true, entryHash: true },
  });
  const ownerAudit = await prisma.adminAuditLog.findFirst({
    where: { action: "amux.v4.initial_source_plan.requested",
      targetType: "AmuxIdeaSubmission", targetId: ideaId, actorUserId },
    select: { metadata: true, entryHash: true },
  });
  const ownerMetadata = ownerAudit?.metadata;
  const valid = plan.state === "active" && chunk?.actorUserId === actorUserId &&
    chunk.sourcePlanRevisionId === plan.id &&
    chunk.planStartChunkIndex === plan.startChunkIndex &&
    chunk.revisionChunkIndex === 0 &&
    !!audit?.entryHash && !!ownerAudit?.entryHash &&
    matchesInitialPlanSystemAudit(audit, plan.manifestDigest) &&
    !!ownerMetadata && typeof ownerMetadata === "object" && !Array.isArray(ownerMetadata) &&
    (ownerMetadata as Record<string, unknown>).revisionId === plan.id &&
    (ownerMetadata as Record<string, unknown>).systemAuditId === plan.creationAuditLogId;
  return valid ? { ideaId, status: "committed", revisionId } :
    { ideaId, status: "partial" };
}

/** The system result and the initiating human action commit or roll back together. */
export async function commitInitialIdeaSourcePlan(tx: Prisma.TransactionClient, input: {
  session: Session; request: Request; ideaId: string; keys: AmuxContentKeys;
}) {
  const result = await createInitialIdeaOnlySourcePlan(tx, {
    ideaId: input.ideaId, actorUserId: ownerId(input.session), keys: input.keys,
  });
  const ownerAuditId = await writeAdminAuditLog({
    tx, session: input.session, request: input.request,
    action: "amux.v4.initial_source_plan.requested",
    targetType: "AmuxIdeaSubmission", targetId: input.ideaId,
    summary: "Owner requested one bounded AMUX v4 idea-only source plan.",
    metadata: { policyVersion: 12, revisionId: result.revisionId,
      systemAuditId: result.auditId, transferAuthorized: false },
  });
  return { ...result, ownerAuditId };
}

/** One deterministic write. A possibly committed response is never retried. */
export async function prepareInitialIdeaSourcePlan(session: Session, request: Request, ideaId: string) {
  const actorUserId = ownerId(session);
  if (!initialPlanWritePermitted(process.env[AMUX_V4_INITIAL_PLAN_WRITE_ENV])) {
    throw new InitialPlanAccessError("plan_disabled", 503);
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new InitialPlanAccessError("integrity_unavailable", 503);
  }
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: ideaId, actorUserId }, select: { id: true },
  });
  if (!owned) throw new InitialPlanAccessError("not_found", 404);
  let keys: AmuxContentKeys;
  try {
    const global = loadCurrentAmuxContentKeys(process.env);
    const identity = { ideaId, purpose: "idea_raw" as const, subjectId: ideaId };
    const unit = await loadAmuxContentUnitKeys(identity);
    keys = amuxContentKeyRing(global, [{ identity, keys: unit }]);
  } catch {
    throw new InitialPlanAccessError("integrity_unavailable", 503);
  }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', '5000', true)`;
      const result = await commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys });
      callbackReturned = true;
      return result;
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (!callbackReturned && error instanceof InitialSourcePlanError) throw error;
    let readBack: InitialPlanAccessError["readBack"] = "unavailable";
    try {
      const observed = (await readInitialIdeaSourcePlan(session, ideaId)).status;
      // A read of absent cannot rule out a still-running or unobserved COMMIT.
      readBack = observed === "absent" ? "unavailable" : observed;
    } catch { /* uncertain */ }
    throw new InitialPlanAccessError("outcome_unknown", 503, readBack);
  }
}
