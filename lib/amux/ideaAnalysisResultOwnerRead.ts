import "server-only";

import type { Session } from "next-auth";

import type { AmuxIdeaAnalysisResultView } from "@/lib/amux/ideaAnalysisResultReadCore";
import { readAmuxFirstIdeaAnalysisResult } from "@/lib/amux/ideaAnalysisResultReadService";
import { amuxAnalysisFreeformSubjectId } from "@/lib/amux/ideaAnalysisDraftSealCore";
import { loadAmuxContentKeyRing, type AmuxContentKeyIdentity } from "@/lib/amux/ideaKeyStore";
import { prisma } from "@/lib/prisma";

/**
 * One analysis page of an idea the signed-in owner submitted, decrypted with
 * exactly the keys its stored rows name. Null when the idea is not theirs.
 * Shared by the result read and its Korean translation, so the translation
 * only ever reads what the owner's own result read would show.
 */
export async function readOwnedAmuxIdeaAnalysisResult(
  session: Session, ideaId: string, chunkIndex: number,
): Promise<AmuxIdeaAnalysisResultView | null> {
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: ideaId, actorUserId: session.user!.id! },
    select: { id: true },
  });
  if (!owned) return null;
  const [chunks, units] = await Promise.all([
    prisma.amuxIdeaAnalysisChunk.findMany({ where: { ideaId,
      chunkIndex, freeformCiphertext: { not: null } },
      select: { currentPreviewId: true } }),
    prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId,
      chunkIndex, derivationGroupId: null,
      bodyCiphertext: { not: null } }, select: { id: true } }),
  ]);
  const identities: AmuxContentKeyIdentity[] = [];
  for (const chunk of chunks) {
    if (chunk.currentPreviewId) identities.push({ ideaId,
      purpose: "analysis_freeform",
      subjectId: amuxAnalysisFreeformSubjectId(ideaId,
        chunk.currentPreviewId) });
  }
  for (const unit of units) identities.push({ ideaId,
    purpose: "analysis_draft", subjectId: unit.id });
  const keys = await loadAmuxContentKeyRing(identities);
  return readAmuxFirstIdeaAnalysisResult(session, ideaId, keys, chunkIndex);
}
