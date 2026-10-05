import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaDuplicateScan, AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";

type Node = AmuxIdeaUnitConfirmationSnapshot["hierarchy"][number];
type CardTarget = Extract<NonNullable<AmuxIdeaUnitConfirmationSnapshot["target"]>,
  { kind: "card" }>;

/** The existing card remains untouched; the owner confirms one immutable
 * proposal -> card relationship with a reason digest. */
export function assembleAmuxV4CardLink(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: { digest: string; keyId: string };
  unit: { id: string; localRef: string; bodyDigest: string;
    bodyDigestKeyId: string };
  proposal: AmuxAnalysisCard;
  preview: { id: string; payloadDigest: string; payloadDigestKeyId: string;
    scopeApprovalId: string | null; scopeDigest: string | null;
    scopeDigestKeyId: string | null };
  hierarchy: [Node, Node, Node]; target: CardTarget;
  sourceFeatureRef: string; duplicateScan: AmuxIdeaDuplicateScan;
  decisionReason: string; key: AmuxDigestKey;
}): AmuxIdeaUnitConfirmationSnapshot | null {
  const { proposal, unit, preview, hierarchy, target, decisionReason } = input;
  if (proposal.kind !== "card" || proposal.localId !== unit.localRef ||
      proposal.featureRef !== input.sourceFeatureRef ||
      target.sourceSystem !== "admin-idea-v4" ||
      target.status === "cancelled" ||
      target.featureNodeId !== hierarchy[2].id ||
      target.cardType !== proposal.cardType ||
      target.storyKind !== proposal.storyKind ||
      !input.duplicateScan.complete ||
      decisionReason !== decisionReason.trim() ||
      decisionReason.length < 3 || decisionReason.length > 500 ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigest === null) ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigestKeyId === null)) {
    return null;
  }
  try {
    const actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", unit.id, input.key);
    if (actual.digest !== unit.bodyDigest ||
        actual.digestKeyId !== unit.bodyDigestKeyId) return null;
    const reason = amuxContentDigest(Buffer.from(decisionReason, "utf8"),
      "analysis_draft", unit.id, input.key);
    return { schemaVersion: 1, policyVersion: "amux-intake-v11",
      canonicalizerVersion: "amux-canonical-v1",
      scannerVersion: input.duplicateScan.scanVersion,
      ideaId: input.ideaId, decisionId: input.decisionId,
      prepareRequestId: input.prepareRequestId,
      actorUserId: input.actorUserId, ownerSession: input.ownerSession,
      draftUnitId: unit.id, localRef: unit.localRef, unitVersion: 1,
      unitKind: "card", unitBody: { digest: unit.bodyDigest,
        keyId: unit.bodyDigestKeyId },
      draftShape: { kind: "card", cardType: proposal.cardType,
        storyKind: proposal.storyKind }, action: "link_existing_card",
      source: { previewId: preview.id,
        payload: { digest: preview.payloadDigest,
          keyId: preview.payloadDigestKeyId },
        scopeApprovalId: preview.scopeApprovalId,
        scope: preview.scopeDigest && preview.scopeDigestKeyId ?
          { digest: preview.scopeDigest,
            keyId: preview.scopeDigestKeyId } : null },
      hierarchy, nodeProposal: null, target, card: null,
      duplicates: input.duplicateScan,
      decisionReason: { digest: reason.digest,
        keyId: reason.digestKeyId } };
  } catch { return null; }
}
