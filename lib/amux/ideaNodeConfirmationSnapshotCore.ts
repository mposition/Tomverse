import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";
import type { AmuxIdeaDuplicateScan, AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";

type Keyed = { digest: string; keyId: string };
type Node = AmuxIdeaUnitConfirmationSnapshot["hierarchy"][number];

/** A parent must already be approved; this only prepares one new node.
 * The operator must separately confirm its parent and any duplicate title. */
export function assembleAmuxV4NodeConfirmation(input: {
  ideaId: string; decisionId: string; prepareRequestId: string;
  actorUserId: string; ownerSession: Keyed; nodeId: string;
  unit: { id: string; localRef: string; bodyDigest: string;
    bodyDigestKeyId: string };
  proposal: AmuxAnalysisNode;
  preview: { id: string; payloadDigest: string; payloadDigestKeyId: string;
    scopeApprovalId: string | null; scopeDigest: string | null;
    scopeDigestKeyId: string | null };
  hierarchy: Node[];
  sourceParentRef: string | null;
  duplicateScan: AmuxIdeaDuplicateScan;
  decisionReason: string | null;
  key: AmuxDigestKey;
}): AmuxIdeaUnitConfirmationSnapshot | null {
  const { proposal, unit, preview, hierarchy } = input;
  const expectedLevel = (["initiative", "epic", "feature"] as const)[hierarchy.length];
  if (hierarchy.length > 2 || proposal.kind !== "node" ||
      proposal.level !== expectedLevel || proposal.localId !== unit.localRef ||
      proposal.parentRef !== input.sourceParentRef ||
      !input.duplicateScan.complete ||
      (input.duplicateScan.candidates.length > 0) !==
        (input.decisionReason !== null) ||
      (input.decisionReason !== null &&
        (input.decisionReason.length < 3 || input.decisionReason.length > 500 ||
          input.decisionReason !== input.decisionReason.trim())) ||
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
      draftUnitId: unit.id, localRef: unit.localRef,
      unitVersion: 1, unitKind: "node",
      unitBody: { digest: unit.bodyDigest, keyId: unit.bodyDigestKeyId },
      draftShape: { kind: "node", level: proposal.level },
      action: "create_node",
      source: { previewId: preview.id,
        payload: { digest: preview.payloadDigest,
          keyId: preview.payloadDigestKeyId },
        scopeApprovalId: preview.scopeApprovalId,
        scope: preview.scopeDigest && preview.scopeDigestKeyId ?
          { digest: preview.scopeDigest,
            keyId: preview.scopeDigestKeyId } : null },
      hierarchy, nodeProposal: { id: input.nodeId, level: proposal.level,
        parentId: hierarchy.at(-1)?.id ?? null },
      target: null, card: null, duplicates: input.duplicateScan,
      decisionReason: reason ? { digest: reason.digest,
        keyId: reason.digestKeyId } : null };
  } catch { return null; }
}
