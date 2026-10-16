import { AMUX_TASK_EXPECTED_PATHS_MAX,
  type AmuxAnalysisCard } from "./ideaAnalysisChunkCore.ts";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { classifyAmuxExecutionPath, deriveAmuxExecutionGrade,
  normalizeAmuxExecutionPath,
  type AmuxExecutionGrade } from "./executionGradeCore.ts";
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
  proposedExecutionGrade: string | null;
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
  | { ok: false; code: "reconfirm" | "reject" | "halt" | "proposal_mismatch" |
    AmuxV20TaskRegistrationRefusal };

export const AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES = Object.freeze([
  "task_expected_paths_missing",
  "task_expected_paths_out_of_range",
  "task_expected_path_invalid",
  "task_expected_paths_duplicate",
  "task_expected_paths_mixed",
  "task_role_review_refused",
  "task_execution_grade_mismatch",
  "task_confirmation_grade_mismatch",
  "task_cost_receipt_grade_mismatch",
] as const);

export type AmuxV20TaskRegistrationRefusal =
  (typeof AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES)[number];

const taskRegistrationRefusals = new Set<string>(
  AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES,
);

export const isAmuxV20TaskRegistrationRefusal = (
  value: unknown,
): value is AmuxV20TaskRegistrationRefusal =>
  typeof value === "string" && taskRegistrationRefusals.has(value);

export const amuxV4CardRegistrationDecisionErrorCode = (
  code: Extract<AmuxV4CardRegistrationInspection, { ok: false }>["code"],
): "integrity_unavailable" | "reconfirm" | AmuxV20TaskRegistrationRefusal =>
  code === "halt" ? "integrity_unavailable" :
    isAmuxV20TaskRegistrationRefusal(code) ? code : "reconfirm";

export type AmuxV20TaskRegistrationInspection =
  | { ok: true; executionGrade: AmuxExecutionGrade }
  | { ok: false; code: AmuxV20TaskRegistrationRefusal };

const id = /^[A-Za-z0-9:_-]{1,128}$/;
const digest = /^[a-f0-9]{64}$/;

/** amux-intake v20 final registration fence. Stored schema 4 Tasks remain
 * readable, but cannot become new cards without reviewed expected paths. */
export function inspectAmuxV20TaskRegistration(
  proposal: AmuxAnalysisCard,
): AmuxV20TaskRegistrationInspection {
  try {
    if (proposal.taskRole === "review") {
      return { ok: false, code: "task_role_review_refused" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(proposal, "expectedPaths");
    if (!descriptor || !("value" in descriptor) || descriptor.value === undefined ||
        descriptor.value === null) {
      return { ok: false, code: "task_expected_paths_missing" };
    }
    if (!Array.isArray(descriptor.value)) {
      return { ok: false, code: "task_expected_path_invalid" };
    }
    const expectedPaths = descriptor.value as unknown[];
    if (expectedPaths.length < 1 || expectedPaths.length > AMUX_TASK_EXPECTED_PATHS_MAX) {
      return { ok: false, code: "task_expected_paths_out_of_range" };
    }
    let contract = false;
    let ordinary = false;
    const normalizedPaths = new Set<string>();
    for (let index = 0; index < expectedPaths.length; index += 1) {
      const pathDescriptor = Object.getOwnPropertyDescriptor(expectedPaths, String(index));
      const path = pathDescriptor && "value" in pathDescriptor ? pathDescriptor.value : null;
      const normalizedPath = normalizeAmuxExecutionPath(path);
      if (normalizedPath === null) {
        return { ok: false, code: "task_expected_path_invalid" };
      }
      if (normalizedPaths.has(normalizedPath)) {
        return { ok: false, code: "task_expected_paths_duplicate" };
      }
      normalizedPaths.add(normalizedPath);
      const pathClass = classifyAmuxExecutionPath(path);
      contract ||= pathClass === "contract";
      ordinary ||= pathClass === "ordinary";
    }
    if (contract && ordinary) {
      return { ok: false, code: "task_expected_paths_mixed" };
    }
    if (!proposal.executionGrade ||
        !["routine", "advanced", "frontier"].includes(proposal.executionGrade)) {
      return { ok: false, code: "task_execution_grade_mismatch" };
    }
    const executionGrade = deriveAmuxExecutionGrade({
      taskRole: proposal.taskRole,
      expectedPaths,
      proposedGrade: proposal.executionGrade,
    });
    return { ok: true, executionGrade };
  } catch {
    return { ok: false, code: "task_expected_path_invalid" };
  }
}

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
          briefDigest?.digest !== card.task.brief.digest ||
          briefDigest?.digestKeyId !== card.task.brief.keyId))) {
    return { ok: false, code: "proposal_mismatch" };
  }
  let executionGrade = proposal.executionGrade;
  if (proposal.cardType === "task") {
    const taskGuard = inspectAmuxV20TaskRegistration(proposal);
    if (!taskGuard.ok) return taskGuard;
    executionGrade = taskGuard.executionGrade;
    if (snapshot.policyVersion !== "amux-intake-v20" ||
        card.task!.proposedGrade !== proposal.executionGrade) {
      return { ok: false, code: "task_confirmation_grade_mismatch" };
    }
    if (card.task!.grade !== taskGuard.executionGrade) {
      return { ok: false, code: "task_confirmation_grade_mismatch" };
    }
    if (card.task!.costReceipt.grade !== taskGuard.executionGrade) {
      return { ok: false, code: "task_cost_receipt_grade_mismatch" };
    }
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
    proposedExecutionGrade: proposal.executionGrade,
    executionGrade,
    maximumCostMicroUsd: card.task?.costReceipt.ceilingMicroUsd ?? null,
    sourceSystem: "admin-idea-v4",
    sourceKey: prepared.draftUnitId.toUpperCase(),
    sourceDigest: prepared.unitDigest,
    sourceDigestKeyId: prepared.unitDigestKeyId,
    status: "backlog", owner: null, claimedAt: null, routeDecisionCount: 0,
  } };
}
