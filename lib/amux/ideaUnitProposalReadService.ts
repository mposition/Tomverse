import "server-only";

import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { readAmuxFirstIdeaAnalysisResult } from "./ideaAnalysisResultReadService.ts";
import { loadAmuxContentKeyRing, type AmuxContentKeyIdentity } from
  "./ideaKeyStore.ts";
import { openAmuxContent, verifyAmuxContentDigest } from "./ideaCrypto.ts";
import { inspectAmuxStoredAnalysisUnit } from "./ideaAnalysisChunkCore.ts";
import type { AmuxAnalysisCard, AmuxAnalysisNode } from
  "./ideaAnalysisChunkCore.ts";

export class AmuxIdeaUnitProposalReadError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "integrity_unavailable") {
    super(code);
    this.name = "AmuxIdeaUnitProposalReadError";
  }
}

/** Reuse the A07 full-chunk commitment check; a browser-provided proposal is
 * never a registration source. This is called again before consuming. */
export async function readVerifiedAmuxUnitProposal(session: Session,
  ideaId: string, draftUnitId: string): Promise<{
    proposal: AmuxAnalysisCard | AmuxAnalysisNode;
    unit: { id: string; localRef: string; bodyDigest: string;
      bodyDigestKeyId: string; chunkIndex: number; expiresAt: Date };
    previewId: string;
  }> {
  const actorUserId = session.user?.id;
  if (!actorUserId || !/^[A-Za-z0-9:_-]{8,80}$/.test(ideaId) ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(draftUnitId)) {
    throw new AmuxIdeaUnitProposalReadError("not_found");
  }
  const unit = await prisma.amuxIdeaDraftUnit.findFirst({ where: {
    id: draftUnitId, ideaId, actorUserId, state: "proposed",
  }, select: { id: true, localRef: true, unitKind: true,
    bodyDigest: true, bodyDigestKeyId: true,
    chunkIndex: true, expiresAt: true, derivationGroupId: true,
    bodyCiphertext: true, bodyKeyId: true, bodyKeyVersion: true,
    bodyPurgedAt: true, bodyPurgeAfter: true } });
  if (!unit) throw new AmuxIdeaUnitProposalReadError("not_found");
  if (!["card", "node"].includes(unit.unitKind) || !unit.localRef) {
    throw new AmuxIdeaUnitProposalReadError("not_ready");
  }
  const chunk = await prisma.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: unit.chunkIndex } },
    select: { currentPreviewId: true, freeformCiphertext: true },
  });
  if (!chunk?.currentPreviewId) throw new AmuxIdeaUnitProposalReadError("not_ready");
  if (unit.derivationGroupId !== null) {
    const [group, edges, audit] = await Promise.all([
      prisma.amuxIdeaDerivationGroup.findFirst({ where: {
        id: unit.derivationGroupId, ideaId, actorUserId,
      } }),
      prisma.amuxIdeaDerivationEdge.findMany({ where: {
        groupId: unit.derivationGroupId, targetUnitId: unit.id,
      }, select: { sourceUnitId: true } }),
      prisma.amuxIdeaDerivationGroup.findUnique({ where: {
        id: unit.derivationGroupId,
      }, select: { approvalAuditLogId: true } }).then((row) =>
        row ? prisma.adminAuditLog.findUnique({ where: {
          id: row.approvalAuditLogId,
        }, select: { action: true, targetType: true, targetId: true,
          actorUserId: true, entryHash: true } }) : null),
    ]);
    if (!group || !audit?.entryHash ||
        audit.action !== "amux.v4.derivation.approve" ||
        audit.targetType !== "AmuxIdeaDerivationGroup" ||
        audit.targetId !== group.id || audit.actorUserId !== actorUserId ||
        edges.length !== group.sourceCount || !unit.bodyCiphertext ||
        !unit.bodyKeyId || !unit.bodyKeyVersion ||
        unit.bodyPurgedAt !== null || new Date() >= unit.expiresAt ||
        (unit.bodyPurgeAfter && new Date() >= unit.bodyPurgeAfter)) {
      throw new AmuxIdeaUnitProposalReadError("integrity_unavailable");
    }
    try {
      const keys = await loadAmuxContentKeyRing([{ ideaId,
        purpose: "analysis_draft", subjectId: unit.id }]);
      const plain = openAmuxContent({ ciphertext: Buffer.from(unit.bodyCiphertext),
        keyId: unit.bodyKeyId, keyVersion: unit.bodyKeyVersion },
      "analysis_draft", unit.id, keys);
      try {
        if (!verifyAmuxContentDigest(plain, "analysis_draft", unit.id,
          unit.bodyDigest, unit.bodyDigestKeyId, keys)) {
          throw new AmuxIdeaUnitProposalReadError("integrity_unavailable");
        }
        const inspected = inspectAmuxStoredAnalysisUnit({
          raw: plain.toString("utf8"), chunkIndex: unit.chunkIndex,
          permittedSourceRefIds: ["operator_idea"],
        });
        if (!inspected.ok || inspected.unit.kind !== "card" ||
            inspected.unit.localId !== unit.localRef) {
          throw new AmuxIdeaUnitProposalReadError("integrity_unavailable");
        }
        return { proposal: inspected.unit, unit: { id: unit.id,
          localRef: unit.localRef, bodyDigest: unit.bodyDigest,
          bodyDigestKeyId: unit.bodyDigestKeyId, chunkIndex: unit.chunkIndex,
          expiresAt: unit.expiresAt }, previewId: chunk.currentPreviewId };
      } finally { plain.fill(0); }
    } catch (error) {
      if (error instanceof AmuxIdeaUnitProposalReadError) throw error;
      throw new AmuxIdeaUnitProposalReadError("integrity_unavailable");
    }
  }
  const siblings = await prisma.amuxIdeaDraftUnit.findMany({ where: {
    ideaId, actorUserId, chunkIndex: unit.chunkIndex,
    derivationGroupId: null,
    bodyCiphertext: { not: null },
  }, select: { id: true } });
  const identities: AmuxContentKeyIdentity[] = siblings.map((sibling) => ({
    ideaId, purpose: "analysis_draft", subjectId: sibling.id,
  }));
  if (chunk.freeformCiphertext) identities.push({ ideaId,
    purpose: "analysis_freeform",
    subjectId: amuxAnalysisFreeformSubjectId(ideaId, chunk.currentPreviewId) });
  try {
    const keys = await loadAmuxContentKeyRing(identities);
    const result = await readAmuxFirstIdeaAnalysisResult(session, ideaId,
      keys, unit.chunkIndex);
    if (result.state !== "ready" && result.state !== "partial" &&
        result.state !== "needs_owner_input") {
      throw new AmuxIdeaUnitProposalReadError("not_ready");
    }
    const visible = result.units.find((item) => item.id === draftUnitId);
    if (!visible || visible.decisionState !== "proposed" ||
        visible.localRef !== unit.localRef ||
        visible.bodyDigest !== unit.bodyDigest ||
        visible.bodyDigestKeyId !== unit.bodyDigestKeyId ||
        visible.proposal?.kind !== unit.unitKind ||
        (visible.proposal.kind !== "card" && visible.proposal.kind !== "node")) {
      throw new AmuxIdeaUnitProposalReadError("integrity_unavailable");
    }
    return { proposal: visible.proposal, unit: { id: unit.id,
      localRef: unit.localRef, bodyDigest: unit.bodyDigest,
      bodyDigestKeyId: unit.bodyDigestKeyId, chunkIndex: unit.chunkIndex,
      expiresAt: unit.expiresAt }, previewId: result.previewId };
  } catch (error) {
    if (error instanceof AmuxIdeaUnitProposalReadError) throw error;
    throw new AmuxIdeaUnitProposalReadError("integrity_unavailable");
  }
}

export async function readVerifiedAmuxCardProposal(session: Session,
  ideaId: string, draftUnitId: string) {
  const result = await readVerifiedAmuxUnitProposal(session, ideaId, draftUnitId);
  if (result.proposal.kind !== "card") {
    throw new AmuxIdeaUnitProposalReadError("not_ready");
  }
  return { ...result, proposal: result.proposal };
}

export async function readVerifiedAmuxNodeProposal(session: Session,
  ideaId: string, draftUnitId: string) {
  const result = await readVerifiedAmuxUnitProposal(session, ideaId, draftUnitId);
  if (result.proposal.kind !== "node") {
    throw new AmuxIdeaUnitProposalReadError("not_ready");
  }
  return { ...result, proposal: result.proposal };
}
