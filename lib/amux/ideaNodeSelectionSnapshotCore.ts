import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaDuplicateScan, AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";

type Node = AmuxIdeaUnitConfirmationSnapshot["hierarchy"][number];

/** Selecting/linking an approved node records a relationship, not a new node. */
export function assembleAmuxV4NodeSelection(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: { digest: string; keyId: string };
  unit: { id: string; localRef: string; bodyDigest: string;
    bodyDigestKeyId: string };
  proposal: AmuxAnalysisNode;
  preview: { id: string; payloadDigest: string; payloadDigestKeyId: string;
    scopeApprovalId: string | null; scopeDigest: string | null;
    scopeDigestKeyId: string | null };
  hierarchy: Node[]; target: Node; sourceParentRef: string | null;
  duplicateScan: AmuxIdeaDuplicateScan;
  action: "select_existing_node" | "link_existing_node";
  decisionReason: string | null; key: AmuxDigestKey;
}): AmuxIdeaUnitConfirmationSnapshot | null {
  const { proposal, unit, preview, hierarchy, target } = input;
  const reasonRequired = input.action === "link_existing_node";
  if (proposal.kind !== "node" || proposal.localId !== unit.localRef ||
      proposal.level !== target.level ||
      proposal.parentRef !== input.sourceParentRef ||
      target.parentId !== (hierarchy.at(-1)?.id ?? null) ||
      hierarchy.length > 2 ||
      (reasonRequired !== (input.decisionReason !== null)) ||
      (input.decisionReason !== null &&
        (input.decisionReason !== input.decisionReason.trim() ||
          input.decisionReason.length < 3 ||
          input.decisionReason.length > 500)) ||
      !input.duplicateScan.complete ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigest === null) ||
      (preview.scopeApprovalId === null) !== (preview.scopeDigestKeyId === null)) {
    return null;
  }
  try {
    const actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", unit.id, input.key);
    if (actual.digest !== unit.bodyDigest ||
        actual.digestKeyId !== unit.bodyDigestKeyId) return null;
    const reason = input.decisionReason === null ? null : amuxContentDigest(
      Buffer.from(input.decisionReason, "utf8"), "analysis_draft", unit.id,
      input.key);
    return { schemaVersion: 1, policyVersion: "amux-intake-v11",
      canonicalizerVersion: "amux-canonical-v1",
      scannerVersion: input.duplicateScan.scanVersion,
      ideaId: input.ideaId, decisionId: input.decisionId,
      prepareRequestId: input.prepareRequestId,
      actorUserId: input.actorUserId, ownerSession: input.ownerSession,
      draftUnitId: unit.id, localRef: unit.localRef, unitVersion: 1,
      unitKind: "node", unitBody: { digest: unit.bodyDigest,
        keyId: unit.bodyDigestKeyId },
      draftShape: { kind: "node", level: proposal.level },
      action: input.action,
      source: { previewId: preview.id,
        payload: { digest: preview.payloadDigest,
          keyId: preview.payloadDigestKeyId },
        scopeApprovalId: preview.scopeApprovalId,
        scope: preview.scopeDigest && preview.scopeDigestKeyId ?
          { digest: preview.scopeDigest,
            keyId: preview.scopeDigestKeyId } : null },
      hierarchy, nodeProposal: null, target: { kind: "node", ...target },
      card: null, duplicates: input.duplicateScan,
      decisionReason: reason ? { digest: reason.digest,
        keyId: reason.digestKeyId } : null };
  } catch { return null; }
}
