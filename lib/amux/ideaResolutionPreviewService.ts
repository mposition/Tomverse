import "server-only";

import type { Session } from "next-auth";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import type { AmuxAnalysisCard, AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";
import { amuxAnalysisFreeformSubjectId } from "./ideaAnalysisDraftSealCore.ts";
import { readAmuxFirstIdeaAnalysisResult } from "./ideaAnalysisResultReadService.ts";
import { loadAmuxContentKeyRing, type AmuxContentKeyIdentity } from "./ideaKeyStore.ts";
import { inspectAmuxResolutionChoices, type AmuxCardResolutionChoice,
  type AmuxExistingResolutionCard } from "./ideaResolutionChoiceCore.ts";
import type { AmuxHierarchySnapshotNode } from
  "./ideaHierarchyDecisionCore.ts";
import type { AmuxNodeResolutionChoice } from "./ideaResolutionChoiceCore.ts";

export class AmuxIdeaResolutionPreviewError extends Error {
  constructor(readonly code: "not_found" | "integrity_unavailable" | "catalog_too_large") {
    super(code);
    this.name = "AmuxIdeaResolutionPreviewError";
  }
}

const MAX_CATALOG = 1_000;
const DIGEST = /^[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9:_-]{1,128}$/;

/** Bounded owner catalog. v4 card title/body is deliberately not copied to the
 * candidate response; legacy card titles are exact-match warnings only and
 * cannot be used as v4 link targets. */
export async function readAmuxIdeaResolutionCatalog(
  session: Session, ideaId: string,
): Promise<{ nodes: AmuxHierarchySnapshotNode[]; cards: AmuxExistingResolutionCard[];
  legacyCards: Array<{ ref: string; title: string }> }> {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner" ||
      !REF.test(ideaId)) throw new AmuxIdeaResolutionPreviewError("not_found");
  const owned = await prisma.amuxIdeaSubmission.findFirst({
    where: { id: ideaId, actorUserId }, select: { id: true },
  });
  if (!owned) throw new AmuxIdeaResolutionPreviewError("not_found");
  const [nodeRows, cardRows, legacyRows] = await prisma.$transaction([
    prisma.amuxPortfolioNode.findMany({ take: MAX_CATALOG + 1,
      orderBy: { id: "asc" }, select: { id: true, level: true, parentId: true,
        revision: true, contentDigest: true, state: true } }),
    prisma.amuxWorkItem.findMany({ where: { sourceSystem: "admin-idea-v4" },
      take: MAX_CATALOG + 1, orderBy: { id: "asc" },
      select: { id: true, sourceSystem: true, cardType: true, storyKind: true,
        parentFeatureNodeId: true, revision: true, v4TitleDigest: true, status: true } }),
    prisma.amuxWorkItem.findMany({ where: { OR: [
      { sourceSystem: null }, { sourceSystem: { not: "admin-idea-v4" } },
    ], archivedAt: null }, take: MAX_CATALOG + 1, orderBy: { id: "asc" },
    select: { id: true, title: true } }),
  ]);
  if (nodeRows.length > MAX_CATALOG || cardRows.length > MAX_CATALOG ||
      legacyRows.length > MAX_CATALOG) {
    throw new AmuxIdeaResolutionPreviewError("catalog_too_large");
  }
  const nodes = nodeRows.map((row) => {
    if (!REF.test(row.id) || !["initiative", "epic", "feature"].includes(row.level) ||
        (row.parentId !== null && !REF.test(row.parentId)) ||
        (row.level === "initiative") !== (row.parentId === null) ||
        !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        !DIGEST.test(row.contentDigest) || !["active", "archived"].includes(row.state)) {
      throw new AmuxIdeaResolutionPreviewError("integrity_unavailable");
    }
    return { ref: row.id, level: row.level as AmuxHierarchySnapshotNode["level"],
      parentRef: row.parentId, revision: row.revision,
      contentDigest: row.contentDigest,
      state: row.state as AmuxHierarchySnapshotNode["state"] };
  });
  const cards = cardRows.map((row) => {
    if (!REF.test(row.id) || row.sourceSystem !== "admin-idea-v4" ||
        !["story", "task"].includes(row.cardType ?? "") ||
        (row.cardType === "story" ? !["general", "bug"].includes(row.storyKind ?? "") :
          row.storyKind !== null) || !row.parentFeatureNodeId ||
        !REF.test(row.parentFeatureNodeId) ||
        !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        !row.v4TitleDigest || !DIGEST.test(row.v4TitleDigest) ||
        !["backlog", "todo", "doing", "review", "done", "blocked", "cancelled"]
          .includes(row.status)) {
      throw new AmuxIdeaResolutionPreviewError("integrity_unavailable");
    }
    return { ref: row.id, sourceSystem: "admin-idea-v4" as const,
      cardType: row.cardType as AmuxExistingResolutionCard["cardType"],
      storyKind: row.storyKind as AmuxExistingResolutionCard["storyKind"],
      featureRef: row.parentFeatureNodeId, revision: row.revision,
      contentDigest: row.v4TitleDigest, status: row.status as AmuxExistingResolutionCard["status"] };
  });
  const legacyCards = legacyRows.flatMap((row) => {
    if (!REF.test(row.id) || typeof row.title !== "string") {
      throw new AmuxIdeaResolutionPreviewError("integrity_unavailable");
    }
    // A07 proposal titles are 1..200 characters. Longer or empty legacy
    // titles cannot match and must not break a different proposal's preview.
    return row.title.length >= 1 && row.title.length <= 200
      ? [{ ref: row.id, title: row.title }] : [];
  });
  return { nodes, cards, legacyCards };
}

/** Server re-reads the HMAC-verified A07 units. Browser-supplied proposal or
 * target snapshots are never accepted. This is read-only and cannot approve. */
export async function previewAmuxIdeaResolution(input: {
  session: Session; ideaId: string; chunkIndex: number;
  nodeChoices: AmuxNodeResolutionChoice[]; cardChoices: AmuxCardResolutionChoice[];
}) {
  const catalog = await readAmuxIdeaResolutionCatalog(input.session, input.ideaId);
  const [chunks, units] = await Promise.all([
    prisma.amuxIdeaAnalysisChunk.findMany({ where: { ideaId: input.ideaId,
      chunkIndex: input.chunkIndex, freeformCiphertext: { not: null } },
      select: { currentPreviewId: true } }),
    prisma.amuxIdeaDraftUnit.findMany({ where: { ideaId: input.ideaId,
      chunkIndex: input.chunkIndex, derivationGroupId: null,
      bodyCiphertext: { not: null } },
      select: { id: true } }),
  ]);
  const identities: AmuxContentKeyIdentity[] = [];
  for (const chunk of chunks) if (chunk.currentPreviewId) identities.push({
    ideaId: input.ideaId, purpose: "analysis_freeform",
    subjectId: amuxAnalysisFreeformSubjectId(input.ideaId, chunk.currentPreviewId),
  });
  for (const unit of units) identities.push({ ideaId: input.ideaId,
    purpose: "analysis_draft", subjectId: unit.id });
  const keys = await loadAmuxContentKeyRing(identities);
  const result = await readAmuxFirstIdeaAnalysisResult(input.session,
    input.ideaId, keys, input.chunkIndex);
  if (result.state !== "ready" && result.state !== "partial" &&
      result.state !== "needs_owner_input") {
    return { ok: false as const, code: "approval_missing" as const };
  }
  const proposalUnits = result.units.filter((unit) => unit.decisionState === "proposed")
    .map((unit) => unit.proposal);
  if (!proposalUnits.some((unit) => unit?.kind === "node" || unit?.kind === "card")) {
    return { ok: false as const, code: "approval_missing" as const };
  }
  return inspectAmuxResolutionChoices({
    nodes: proposalUnits.filter((unit): unit is AmuxAnalysisNode => unit?.kind === "node"),
    cards: proposalUnits.filter((unit): unit is AmuxAnalysisCard => unit?.kind === "card"),
    nodeChoices: input.nodeChoices, cardChoices: input.cardChoices,
    existingNodes: catalog.nodes, existingCards: catalog.cards,
  });
}
