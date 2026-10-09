import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import type { AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";
import { checkAmuxIdeaUnitConsume, type AmuxIdeaUnitConsumeContext,
  type PreparedAmuxIdeaUnitDecision } from "./ideaUnitConsumeGuard.ts";
import type { AmuxIdeaUnitConfirmationResult,
  AmuxIdeaUnitConfirmationSnapshot } from "./ideaUnitConfirmationCore.ts";

type PreparedNodeDecision = PreparedAmuxIdeaUnitDecision & {
  unitDigest: string; unitDigestKeyId: string;
  sourcePreviewId: string; sourcePreviewDigest: string;
  sourcePreviewDigestKeyId: string;
};

/** Pure fence for one non-executable portfolio node. */
export function inspectAmuxV4NodeCreation(input: {
  prepared: PreparedNodeDecision;
  context: AmuxIdeaUnitConsumeContext;
  confirmation: AmuxIdeaUnitConfirmationResult;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisNode;
  digestKey: AmuxDigestKey;
}): { ok: true; plan: { id: string; parentId: string | null;
  level: AmuxAnalysisNode["level"]; title: string; description: string;
  decisionId: string; ideaId: string; draftUnitId: string } } |
  { ok: false; code: "reconfirm" | "reject" | "halt" | "proposal_mismatch" } {
  const check = checkAmuxIdeaUnitConsume(input.prepared, {
    ...input.context, currentConfirmation: input.confirmation });
  if (check.decision !== "allow") return { ok: false, code: check.decision };
  const { snapshot, prepared, proposal } = input;
  let actual;
  try {
    actual = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", prepared.draftUnitId, input.digestKey);
  } catch { return { ok: false, code: "proposal_mismatch" }; }
  const node = snapshot.nodeProposal;
  if (snapshot.action !== "create_node" || snapshot.unitKind !== "node" ||
      snapshot.draftShape.kind !== "node" || !node || snapshot.card !== null ||
      snapshot.target !== null || proposal.kind !== "node" ||
      snapshot.ideaId !== prepared.ideaId ||
      snapshot.decisionId !== prepared.id ||
      snapshot.draftUnitId !== prepared.draftUnitId ||
      snapshot.actorUserId !== prepared.actorUserId ||
      snapshot.unitBody.digest !== prepared.unitDigest ||
      snapshot.unitBody.keyId !== prepared.unitDigestKeyId ||
      actual.digest !== prepared.unitDigest ||
      actual.digestKeyId !== prepared.unitDigestKeyId ||
      snapshot.source.previewId !== prepared.sourcePreviewId ||
      snapshot.source.payload.digest !== prepared.sourcePreviewDigest ||
      snapshot.source.payload.keyId !== prepared.sourcePreviewDigestKeyId ||
      snapshot.localRef !== proposal.localId ||
      snapshot.draftShape.level !== proposal.level ||
      node.level !== proposal.level ||
      node.parentId !== (snapshot.hierarchy.at(-1)?.id ?? null) ||
      proposal.title.length < 1 || proposal.title.length > 200 ||
      proposal.description.length > 4_000) {
    return { ok: false, code: "proposal_mismatch" };
  }
  return { ok: true, plan: { id: node.id, parentId: node.parentId,
    level: node.level, title: proposal.title,
    description: proposal.description, decisionId: prepared.id,
    ideaId: prepared.ideaId, draftUnitId: prepared.draftUnitId } };
}
