import type { AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxContentDigest, type AmuxDigestKey } from "./ideaCrypto.ts";
import { type AmuxIdeaUnitConfirmationSnapshot,
  type AmuxIdeaUnitConfirmationResult } from "./ideaUnitConfirmationCore.ts";
import { checkAmuxIdeaUnitConsume, type AmuxIdeaUnitConsumeContext,
  type PreparedAmuxIdeaUnitDecision } from "./ideaUnitConsumeGuard.ts";

type PreparedCardDecision = PreparedAmuxIdeaUnitDecision & {
  unitDigest: string;
  unitDigestKeyId: string;
  sourcePreviewId: string;
  sourcePreviewDigest: string;
  sourcePreviewDigestKeyId: string;
};

/** One verified proposal may create one inert backlog card. This is a pure
 * fence: neither a model choice nor a browser preview is registration authority. */
export type AmuxV4CardRegistrationPlan = {
  decisionId: string;
  ideaId: string;
  draftUnitId: string;
  cardType: "story" | "task";
  storyKind: "general" | "bug" | null;
  featureNodeId: string;
  parentStoryCardId: string | null;
  dependencyIds: string[];
  title: string;
  body: { problem: string; scopeIn: string[]; scopeOut: string[];
    completionCriteria: string[] };
  executionBrief: string | null;
  taskRole: string | null;
  executionGrade: string | null;
  maximumCostMicroUsd: string | null;
  sourceSystem: "admin-idea-v4";
  sourceKey: string;
  sourceDigest: string;
  sourceDigestKeyId: string;
  status: "backlog";
  owner: null;
  claimedAt: null;
  routeDecisionCount: 0;
};

export type AmuxV4CardRegistrationInspection =
  | { ok: true; plan: AmuxV4CardRegistrationPlan }
  | { ok: false; code: "reconfirm" | "reject" | "halt" | "proposal_mismatch" };

const id = /^[A-Za-z0-9:_-]{1,128}$/;
const digest = /^[a-f0-9]{64}$/;

export function inspectAmuxV4CardRegistration(input: {
  prepared: PreparedCardDecision;
  context: AmuxIdeaUnitConsumeContext;
  confirmation: AmuxIdeaUnitConfirmationResult;
  snapshot: AmuxIdeaUnitConfirmationSnapshot;
  proposal: AmuxAnalysisCard;
  digestKey: AmuxDigestKey;
  /** Server-resolved local Feature reference, never browser supplied. */
  resolvedFeatureRef: string;
}): AmuxV4CardRegistrationInspection {
  const consume = checkAmuxIdeaUnitConsume(input.prepared, {
    ...input.context, currentConfirmation: input.confirmation,
  });
  if (consume.decision !== "allow") return { ok: false, code: consume.decision };
  const { snapshot, proposal, prepared } = input;
  const card = snapshot.card;
  let proposalDigest: { digest: string; digestKeyId: string };
  let briefDigest: { digest: string; digestKeyId: string } | null = null;
  try {
    proposalDigest = amuxContentDigest(Buffer.from(amuxCanonicalJson(proposal), "utf8"),
      "analysis_draft", prepared.draftUnitId, input.digestKey);
    if (proposal.executionBrief !== null) {
      briefDigest = amuxContentDigest(Buffer.from(proposal.executionBrief, "utf8"),
        "analysis_draft", prepared.draftUnitId, input.digestKey);
    }
  } catch { return { ok: false, code: "proposal_mismatch" }; }
  if (snapshot.action !== "register_card" || snapshot.unitKind !== "card" ||
      snapshot.draftShape.kind !== "card" || card === null ||
      snapshot.target !== null || snapshot.nodeProposal !== null ||
      !proposal || proposal.kind !== "card" ||
      snapshot.ideaId !== prepared.ideaId || snapshot.decisionId !== prepared.id ||
      snapshot.draftUnitId !== prepared.draftUnitId ||
      snapshot.actorUserId !== prepared.actorUserId ||
      snapshot.unitBody.digest !== prepared.unitDigest ||
      snapshot.unitBody.keyId !== prepared.unitDigestKeyId ||
      card.normalizedBody.digest !== prepared.unitDigest ||
      card.normalizedBody.keyId !== prepared.unitDigestKeyId ||
      proposalDigest.digest !== prepared.unitDigest ||
      proposalDigest.digestKeyId !== prepared.unitDigestKeyId ||
      snapshot.source.previewId !== prepared.sourcePreviewId ||
      snapshot.source.payload.digest !== prepared.sourcePreviewDigest ||
      snapshot.source.payload.keyId !== prepared.sourcePreviewDigestKeyId ||
      snapshot.localRef !== proposal.localId ||
      !id.test(input.resolvedFeatureRef) ||
      snapshot.hierarchy.at(-1)?.id !== input.resolvedFeatureRef ||
      card.featureNodeId !== input.resolvedFeatureRef ||
      card.cardType !== proposal.cardType || card.storyKind !== proposal.storyKind ||
      snapshot.draftShape.cardType !== proposal.cardType ||
      snapshot.draftShape.storyKind !== proposal.storyKind ||
      !id.test(prepared.draftUnitId) || !digest.test(prepared.unitDigest) ||
      proposal.title.length < 1 || proposal.title.length > 200 ||
      proposal.featureRef.length < 1 ||
      (proposal.cardType === "story" &&
        (proposal.executionBrief !== null || proposal.taskRole !== null ||
          proposal.executionGrade !== null || card.task !== null)) ||
      (proposal.cardType === "task" &&
        (proposal.executionBrief === null || proposal.taskRole === null ||
          proposal.executionGrade === null || card.task === null ||
          card.task.role !== proposal.taskRole ||
          card.task.grade !== proposal.executionGrade ||
          briefDigest?.digest !== card.task.brief.digest ||
          briefDigest?.digestKeyId !== card.task.brief.keyId))) {
    return { ok: false, code: "proposal_mismatch" };
  }
  return { ok: true, plan: {
    decisionId: prepared.id, ideaId: prepared.ideaId,
    draftUnitId: prepared.draftUnitId,
    cardType: proposal.cardType, storyKind: proposal.storyKind,
    featureNodeId: card.featureNodeId,
    parentStoryCardId: card.parentStory?.id ?? null,
    dependencyIds: card.dependencies.map((entry) => entry.id),
    title: proposal.title,
    body: { problem: proposal.problem, scopeIn: [...proposal.scopeIn],
      scopeOut: [...proposal.scopeOut],
      completionCriteria: [...proposal.completionCriteria] },
    executionBrief: proposal.executionBrief,
    taskRole: proposal.taskRole,
    executionGrade: proposal.executionGrade,
    maximumCostMicroUsd: card.task?.costReceipt.ceilingMicroUsd ?? null,
    sourceSystem: "admin-idea-v4",
    sourceKey: prepared.draftUnitId.toUpperCase(),
    sourceDigest: prepared.unitDigest,
    sourceDigestKeyId: prepared.unitDigestKeyId,
    status: "backlog", owner: null, claimedAt: null, routeDecisionCount: 0,
  } };
}
