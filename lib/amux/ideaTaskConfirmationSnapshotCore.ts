import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaDuplicateScan, AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import type { V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";

type Keyed = { digest: string; keyId: string };
type Node = AmuxIdeaUnitConfirmationSnapshot["hierarchy"][number];
type CardReference = NonNullable<
  NonNullable<AmuxIdeaUnitConfirmationSnapshot["card"]>["parentStory"]>;

/** The server resolves all references and the approved Agent-only price before
 * assembling this metadata-only owner receipt. Model text is never authority. */
export function assembleAmuxV4TaskConfirmation(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: Keyed;
  unit: { id: string; localRef: string; bodyDigest: string;
    bodyDigestKeyId: string };
  proposal: AmuxAnalysisCard;
  preview: { id: string; payloadDigest: string; payloadDigestKeyId: string;
    scopeApprovalId: string | null; scopeDigest: string | null;
    scopeDigestKeyId: string | null };
  hierarchy: [Node, Node, Node]; sourceFeatureRef: string;
  parentStory: CardReference | null; dependencies: CardReference[];
  costReceipt: V4TaskCostCeilingReceipt;
  publicPrDisclosureApproved: boolean;
  duplicateScan: AmuxIdeaDuplicateScan; decisionReason: string | null;
  key: AmuxDigestKey;
}): AmuxIdeaUnitConfirmationSnapshot | null {
  const { unit, proposal, preview, hierarchy } = input;
  if (proposal.kind !== "card" || proposal.cardType !== "task" ||
      proposal.storyKind !== null || proposal.localId !== unit.localRef ||
      proposal.featureRef !== input.sourceFeatureRef ||
      hierarchy[2].level !== "feature" ||
      proposal.executionBrief === null || proposal.taskRole === null ||
      proposal.executionGrade === null ||
      (input.publicPrDisclosureApproved && proposal.taskRole !== "implement") ||
      input.costReceipt.role !== proposal.taskRole ||
      input.costReceipt.grade !== proposal.executionGrade ||
      (proposal.parentStoryRef === null) !== (input.parentStory === null) ||
      proposal.dependencyRefs.length !== input.dependencies.length ||
      new Set(input.dependencies.map((entry) => entry.id)).size !==
        input.dependencies.length ||
      !input.duplicateScan.complete ||
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
    const actualBody = amuxContentDigest(
      Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", unit.id, input.key);
    const brief = amuxContentDigest(Buffer.from(proposal.executionBrief, "utf8"),
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
      draftShape: { kind: "card", cardType: "task", storyKind: null },
      action: "register_card",
      source: { previewId: preview.id,
        payload: { digest: preview.payloadDigest,
          keyId: preview.payloadDigestKeyId },
        scopeApprovalId: preview.scopeApprovalId,
        scope: preview.scopeDigest && preview.scopeDigestKeyId ?
          { digest: preview.scopeDigest, keyId: preview.scopeDigestKeyId } : null },
      hierarchy, nodeProposal: null, target: null,
      card: { cardType: "task", storyKind: null, normalizedBody: body,
        featureNodeId: hierarchy[2].id,
        parentStory: input.parentStory, dependencies: input.dependencies,
        evidence: [], task: { role: proposal.taskRole,
          grade: proposal.executionGrade,
          publicPrDisclosureApproved: input.publicPrDisclosureApproved,
          brief: { digest: brief.digest, keyId: brief.digestKeyId },
          costReceipt: input.costReceipt } },
      duplicates: input.duplicateScan, decisionReason };
  } catch { return null; }
}
