import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
  AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
} from "@/lib/adminAuditSystemActors";
import { AMUX_V4_IDEA_SYSTEM_ACTOR, AMUX_V4_IDEA_SOURCE_SYSTEM } from "./ideaIdentityCore.ts";
import { openAmuxContent, verifyAmuxContentDigest, type AmuxContentKeys } from "./ideaCrypto.ts";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import { buildAmuxSourcePlanManifest } from "./ideaSourcePlanManifestCore.ts";

export class InitialSourcePlanError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "external_scope_required" | "integrity_unavailable") {
    super(code);
    this.name = "InitialSourcePlanError";
  }
}

/** A dark transaction body for synthetic DB proof only. No route, service
 * trigger, worker or model caller is wired to it. It can create only the
 * initial operator-idea unit: GitHub collection needs its own owner-reviewed
 * scope and exact preview before any source-plan revision can include it. */
export async function createInitialIdeaOnlySourcePlan(
  tx: Prisma.TransactionClient,
  input: { ideaId: string; actorUserId: string; keys: AmuxContentKeys },
): Promise<{ revisionId: string; manifestDigest: string; auditId: string }> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission"
    WHERE "id" = ${input.ideaId} AND "actorUserId" = ${input.actorUserId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new InitialSourcePlanError("not_found");
  const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new InitialSourcePlanError("integrity_unavailable");
  }
  const idea = await tx.amuxIdeaSubmission.findUnique({
    where: { id: input.ideaId },
    select: {
      state: true, actorUserId: true, analysisDeadlineAt: true,
      currentSourcePlanRevisionId: true, rawCiphertext: true,
      rawKeyId: true, rawKeyVersion: true, rawDigest: true,
      rawDigestKeyId: true, rawPurgedAt: true,
    },
  });
  if (!idea || idea.actorUserId !== input.actorUserId) {
    throw new InitialSourcePlanError("not_found");
  }
  if (idea.state !== "submitted" || now >= idea.analysisDeadlineAt ||
      idea.currentSourcePlanRevisionId !== null || idea.rawPurgedAt !== null ||
      !idea.rawCiphertext || !idea.rawKeyId || !idea.rawKeyVersion ||
      !idea.rawDigest || !idea.rawDigestKeyId) {
    throw new InitialSourcePlanError("not_ready");
  }
  const submittedAudit = await tx.adminAuditLog.findFirst({
    where: { action: "AMUX_V4_IDEA_SUBMITTED", targetType: "AmuxIdeaSubmission",
      targetId: input.ideaId, actorUserId: input.actorUserId },
    select: { id: true },
  });
  if (!submittedAudit) throw new InitialSourcePlanError("integrity_unavailable");

  let plain: Buffer;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(idea.rawCiphertext),
      keyId: idea.rawKeyId, keyVersion: idea.rawKeyVersion },
    "idea_raw", input.ideaId, input.keys);
  } catch {
    throw new InitialSourcePlanError("integrity_unavailable");
  }
  let ideaBytes: Buffer | undefined;
  try {
    if (!verifyAmuxContentDigest(plain, "idea_raw", input.ideaId,
      idea.rawDigest, idea.rawDigestKeyId, input.keys)) {
      throw new InitialSourcePlanError("integrity_unavailable");
    }
    const parsed = inspectAmuxIdeaInput(plain.toString("utf8"));
    if (!parsed.ok) throw new InitialSourcePlanError("integrity_unavailable");
    if (parsed.input.repositories.length !== 0 || parsed.input.pullRequests.length !== 0) {
      throw new InitialSourcePlanError("external_scope_required");
    }
    ideaBytes = Buffer.from(parsed.input.idea, "utf8");
    const revisionId = randomUUID();
    const built = buildAmuxSourcePlanManifest({
      ideaId: input.ideaId,
      actorUserId: input.actorUserId,
      revisionId,
      revisionNumber: 1,
      startChunkIndex: 0,
      predecessorId: null,
      orderedUnits: [{ sourceKind: "operator_idea",
        sourceReceiptDigest: idea.rawDigest, bytes: ideaBytes }],
    }, input.keys);
    if (built.decision !== "ready") throw new InitialSourcePlanError("integrity_unavailable");
    const { manifest } = built;
    const auditId = await writeSystemAuditLog({
      tx,
      systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      action: AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
      targetType: AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
      targetId: revisionId,
      summary: "Created one bounded operator-idea source plan; no external source or model transfer.",
      metadata: {
        policyVersion: 12,
        sourceSystem: AMUX_V4_IDEA_SOURCE_SYSTEM,
        ideaId: input.ideaId,
        submittedAuditId: submittedAudit.id,
        revisionNumber: 1,
        sourceUnitCount: manifest.sourceUnitCount,
        initialChunkIndex: 0,
        manifestDigest: manifest.manifestDigest,
        manifestDigestKeyId: manifest.manifestDigestKeyId,
        transferAuthorized: false,
      },
    });
    await tx.amuxIdeaSourcePlanRevision.create({
      data: {
        id: revisionId, ideaId: input.ideaId, actorUserId: input.actorUserId,
        revisionNumber: 1, startChunkIndex: 0,
        sourceUnitCount: manifest.sourceUnitCount,
        unitDigests: manifest.unitDigests,
        manifestDigest: manifest.manifestDigest,
        manifestDigestKeyId: manifest.manifestDigestKeyId,
        state: "prepared", creationAuditLogId: auditId,
      },
    });
    await tx.amuxIdeaSourcePlanRevision.update({
      where: { id: revisionId }, data: { state: "active" },
    });
    await tx.amuxIdeaAnalysisChunk.create({
      data: {
        ideaId: input.ideaId, actorUserId: input.actorUserId,
        chunkIndex: 0, state: "pending", attempt: 0, leaseGeneration: 0,
        sourcePlanRevisionId: revisionId, planStartChunkIndex: 0,
        revisionChunkIndex: 0,
      },
    });
    const updated = await tx.amuxIdeaSubmission.updateMany({
      where: { id: input.ideaId, actorUserId: input.actorUserId,
        currentSourcePlanRevisionId: null, state: "submitted" },
      data: { currentSourcePlanRevisionId: revisionId },
    });
    if (updated.count !== 1) throw new InitialSourcePlanError("not_ready");
    return { revisionId, manifestDigest: manifest.manifestDigest, auditId };
  } finally {
    ideaBytes?.fill(0);
    plain.fill(0);
  }
}
