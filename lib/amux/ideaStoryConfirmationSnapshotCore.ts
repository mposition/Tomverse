import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaDuplicateScan, AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";

type Keyed = { digest: string; keyId: string };
type Node = AmuxIdeaUnitConfirmationSnapshot["hierarchy"][number];

/** Smallest A09 registration slice: one independent Story under an already
 * owner-approved, active Feature. It does not silently accept a proposed
 * parent, linked Story, Task price, or unverified dependency. */
export function assembleAmuxV4StoryConfirmation(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: Keyed;
  unit: { id: string; localRef: string; bodyDigest: string;
    bodyDigestKeyId: string };
  proposal: AmuxAnalysisCard;
  preview: { id: string; payloadDigest: string; payloadDigestKeyId: string;
    scopeApprovalId: string | null; scopeDigest: string | null;
    scopeDigestKeyId: string | null };
  hierarchy: [Node, Node, Node];
  /** Verified mapping from the model's ref to an approved Feature row. */
  sourceFeatureRef: string;
  duplicateScan: AmuxIdeaDuplicateScan;
  decisionReason: string | null;
  key: AmuxDigestKey;
}): AmuxIdeaUnitConfirmationSnapshot | null {
  const { unit, proposal, preview, hierarchy } = input;
  if (proposal.kind !== "card" || proposal.cardType !== "story" ||
      !["general", "bug"].includes(proposal.storyKind ?? "") ||
      proposal.localId !== unit.localRef ||
      proposal.featureRef !== input.sourceFeatureRef ||
      hierarchy[2].id.length < 8 || hierarchy[2].level !== "feature" ||
      proposal.parentStoryRef !== null || proposal.dependencyRefs.length !== 0 ||
      proposal.executionBrief !== null || proposal.taskRole !== null ||
      proposal.executionGrade !== null || !input.duplicateScan.complete ||
      (input.duplicateScan.candidates.length > 0) !==
        (input.decisionReason !== null) ||
      (input.decisionReason !== null && (input.decisionReason.length < 3 ||
        input.decisionReason.length > 500 ||
        input.decisionReason !== input.decisionReason.trim())) ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigest === null) ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigestKeyId === null)) {
    return null;
  }
  try {
    const actualBody = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", unit.id, input.key);
    if (actualBody.digest !== unit.bodyDigest ||
        actualBody.digestKeyId !== unit.bodyDigestKeyId) return null;
    const body = { digest: unit.bodyDigest, keyId: unit.bodyDigestKeyId };
    const decisionReason = input.decisionReason === null ? null : (() => {
      const value = amuxContentDigest(Buffer.from(input.decisionReason, "utf8"),
        "analysis_draft", unit.id, input.key);
      return { digest: value.digest, keyId: value.digestKeyId };
    })();
    return { schemaVersion: 1, policyVersion: "amux-intake-v11",
      canonicalizerVersion: "amux-canonical-v1",
      scannerVersion: input.duplicateScan.scanVersion,
      ideaId: input.ideaId, decisionId: input.decisionId,
      prepareRequestId: input.prepareRequestId,
      actorUserId: input.actorUserId, ownerSession: input.ownerSession,
      draftUnitId: unit.id, localRef: unit.localRef,
      unitVersion: 1, unitKind: "card", unitBody: body,
      draftShape: { kind: "card", cardType: "story",
        storyKind: proposal.storyKind }, action: "register_card",
      source: { previewId: preview.id,
        payload: { digest: preview.payloadDigest,
          keyId: preview.payloadDigestKeyId },
        scopeApprovalId: preview.scopeApprovalId,
        scope: preview.scopeDigest && preview.scopeDigestKeyId ?
          { digest: preview.scopeDigest, keyId: preview.scopeDigestKeyId } : null },
      hierarchy, nodeProposal: null, target: null,
      card: { cardType: "story", storyKind: proposal.storyKind,
        normalizedBody: body, featureNodeId: hierarchy[2].id,
        parentStory: null, dependencies: [], evidence: [], task: null },
      duplicates: input.duplicateScan, decisionReason };
  } catch { return null; }
}
