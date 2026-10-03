import "server-only";

import type { Prisma } from "@prisma/client";

import { auditRowActorKind, AMUX_V4_ANALYSIS_RESULT_ACTION,
  AMUX_V4_ANALYSIS_RESULT_TARGET } from "@/lib/adminAuditSystemActors";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "./ideaCrypto.ts";

export async function readVerifiedAmuxOwnerInputHold(
  tx: Prisma.TransactionClient, actorUserId: string, ideaId: string,
  chunkIndex: number, keys: AmuxContentKeys,
): Promise<{ state: "owner_input"; ideaId: string; chunkIndex: number;
  ownerQuestion: string | null; remainingScope: string | null }> {
  const chunk = await tx.amuxIdeaAnalysisChunk.findUnique({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex } },
  });
  if (!chunk || chunk.actorUserId !== actorUserId ||
      chunk.state !== "owner_input" || !chunk.currentPreviewId ||
      chunk.analysisCompletedAt !== null) throw new Error("owner input hold unavailable");
  const preview = await tx.amuxIdeaTransferPreview.findUnique({
    where: { id: chunk.currentPreviewId },
    select: { state: true, ideaId: true, chunkIndex: true },
  });
  const hold = await tx.amuxIdeaAnalysisBudgetHold.findUnique({
    where: { previewId: chunk.currentPreviewId }, select: { status: true },
  });
  const audits = await tx.adminAuditLog.findMany({ where: {
    action: AMUX_V4_ANALYSIS_RESULT_ACTION,
    targetType: AMUX_V4_ANALYSIS_RESULT_TARGET,
    targetId: chunk.currentPreviewId,
  }, take: 2 });
  const audit = audits[0];
  const metadata = audit?.metadata;
  if (preview?.state !== "owner_input" || preview.ideaId !== ideaId ||
      preview.chunkIndex !== chunkIndex || hold?.status !== "succeeded" ||
      audits.length !== 1 || !audit?.entryHash ||
      auditRowActorKind(audit) !== "system" ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      (metadata as Record<string, unknown>).state !== "owner_input" ||
      (metadata as Record<string, unknown>).ideaId !== ideaId) {
    throw new Error("owner input hold integrity unavailable");
  }
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !chunk.freeformPurgeAfter) {
    throw new Error("owner input hold clock unavailable");
  }
  // Retention is a read boundary, not only a best-effort purge-job deadline.
  if (chunk.freeformPurgedAt !== null || now >= chunk.freeformPurgeAfter) {
    return { state: "owner_input", ideaId, chunkIndex,
      ownerQuestion: null, remainingScope: null };
  }
  if (!chunk.freeformCiphertext || !chunk.freeformKeyId ||
      !chunk.freeformKeyVersion) throw new Error("owner input text unavailable");
  const plain = openAmuxContent({ ciphertext: Buffer.from(chunk.freeformCiphertext),
    keyId: chunk.freeformKeyId, keyVersion: chunk.freeformKeyVersion },
  "analysis_freeform", amuxAnalysisFreeformSubjectId(ideaId, chunk.currentPreviewId), keys);
  try {
    const record = JSON.parse(plain.toString("utf8")) as Record<string, unknown>;
    if (Object.keys(record).length !== 2 ||
        typeof record.ownerQuestion !== "string" ||
        record.ownerQuestion.length < 1 || record.ownerQuestion.length > 2_000 ||
        (record.remainingScope !== null &&
          (typeof record.remainingScope !== "string" || record.remainingScope.length > 2_000)) ||
        amuxCanonicalJson(record) !== plain.toString("utf8") ||
        !verifyAmuxContentDigest(plain, "analysis_freeform",
          amuxAnalysisFreeformSubjectId(ideaId, chunk.currentPreviewId),
          String((metadata as Record<string, unknown>).ownerInputDigest),
          String((metadata as Record<string, unknown>).ownerInputDigestKeyId), keys)) {
      throw new Error("owner input text integrity unavailable");
    }
    return { state: "owner_input", ideaId, chunkIndex,
      ownerQuestion: record.ownerQuestion,
      remainingScope: record.remainingScope as string | null };
  } finally { plain.fill(0); }
}
