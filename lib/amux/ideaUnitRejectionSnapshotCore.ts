import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxAnalysisCard, AmuxAnalysisNode } from
  "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";

/** Rejecting a proposal is an owner decision, not a cancelled preparation.
 * Keep the reason as a keyed digest and do not retain model text in audit. */
export function assembleAmuxV4UnitRejection(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: { digest: string; keyId: string };
  unit: { id: string; localRef: string; bodyDigest: string;
    bodyDigestKeyId: string };
  proposal: AmuxAnalysisCard | AmuxAnalysisNode;
  preview: { id: string; payloadDigest: string; payloadDigestKeyId: string;
    scopeApprovalId: string | null; scopeDigest: string | null;
    scopeDigestKeyId: string | null };
  reason: string; key: AmuxDigestKey;
}): AmuxIdeaUnitConfirmationSnapshot | null {
  const { proposal, unit, preview, reason } = input;
  if (proposal.localId !== unit.localRef ||
      reason !== reason.trim() || reason.length < 3 || reason.length > 500 ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigest === null) ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigestKeyId === null)) {
    return null;
  }
  try {
    const actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", unit.id, input.key);
    const reasonDigest = amuxContentDigest(Buffer.from(reason, "utf8"),
      "analysis_draft", unit.id, input.key);
    if (actual.digest !== unit.bodyDigest ||
        actual.digestKeyId !== unit.bodyDigestKeyId) return null;
    return { schemaVersion: 1, policyVersion: "amux-intake-v11",
      canonicalizerVersion: "amux-canonical-v1", scannerVersion: "rejection-v1",
      ideaId: input.ideaId, decisionId: input.decisionId,
      prepareRequestId: input.prepareRequestId,
      actorUserId: input.actorUserId, ownerSession: input.ownerSession,
      draftUnitId: unit.id, localRef: unit.localRef,
      unitVersion: 1, unitKind: proposal.kind,
      unitBody: { digest: unit.bodyDigest, keyId: unit.bodyDigestKeyId },
      draftShape: proposal.kind === "node" ?
        { kind: "node", level: proposal.level } :
        { kind: "card", cardType: proposal.cardType,
          storyKind: proposal.storyKind },
      action: "reject_unit",
      source: { previewId: preview.id,
        payload: { digest: preview.payloadDigest,
          keyId: preview.payloadDigestKeyId },
        scopeApprovalId: preview.scopeApprovalId,
        scope: preview.scopeDigest && preview.scopeDigestKeyId ?
          { digest: preview.scopeDigest, keyId: preview.scopeDigestKeyId } : null },
      hierarchy: [], nodeProposal: null, target: null, card: null,
      duplicates: null,
      decisionReason: { digest: reasonDigest.digest,
        keyId: reasonDigest.digestKeyId } };
  } catch { return null; }
}
