import type { AmuxAnalysisCard, AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";
import { inspectAmuxHierarchyChoices, type AmuxHierarchyChoice,
  type AmuxHierarchySnapshotNode } from "./ideaHierarchyDecisionCore.ts";

export const AMUX_V4_RESOLUTION_PREVIEW_ENV = "TOMVERSE_AMUX_V4_RESOLUTION_PREVIEW";
export const AMUX_V4_RESOLUTION_PREVIEW_CODE_ENABLED = true;
export const amuxV4ResolutionPreviewEnabled = (value: string | undefined): boolean =>
  AMUX_V4_RESOLUTION_PREVIEW_CODE_ENABLED && value === "enabled";

/** A08 is a decision preview, not a registration or an approval receipt.
 * Stage 9 must re-read every referenced row and consume a separate owner
 * confirmation in the same transaction as its canonical writes. */
export type AmuxExistingResolutionCard = {
  ref: string;
  sourceSystem: "admin-idea-v4";
  cardType: "story" | "task";
  storyKind: "general" | "bug" | null;
  featureRef: string;
  revision: number;
  contentDigest: string;
  status: "backlog" | "todo" | "doing" | "review" | "done" | "blocked" | "cancelled";
};

export type AmuxCardResolutionChoice = {
  proposalLocalId: string;
  action: "register" | "link_existing" | "split" | "merge" | "reject";
  targetRef: string | null;
  targetRevision: number | null;
  targetDigest: string | null;
  relatedLocalRefs: string[];
  reason: string | null;
};

export type AmuxNodeResolutionChoice = Omit<AmuxHierarchyChoice, "action"> & {
  action: AmuxHierarchyChoice["action"] | "reject";
  reason?: string | null;
};

export type AmuxResolutionPlan = {
  nodes: ReturnType<typeof inspectAmuxHierarchyChoices> & { ok: true };
  rejectedNodes: string[];
  cards: Array<{
    proposalLocalId: string;
    action: AmuxCardResolutionChoice["action"];
    feature: { kind: "existing" | "proposed_create"; ref: string } | null;
    parentStory: { kind: "existing" | "proposed_register"; ref: string } | null;
    target: { ref: string; revision: number; digest: string } | null;
    relatedLocalRefs: string[];
    /** Split/merge never registers a card; a separately approved derived unit is required. */
    requiresDerivedUnit: boolean;
  }>;
};

export type AmuxResolutionInspection =
  | { ok: true; plan: AmuxResolutionPlan }
  | { ok: false; code: "invalid_input" | "approval_missing" | "snapshot_conflict" |
      "hierarchy_conflict" | "duplicate_conflict" | "derivation_required" };

const REF = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const validRef = (value: unknown): value is string =>
  typeof value === "string" && REF.test(value);
const validRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const validReason = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 3 && value.length <= 500 &&
  value.trim() === value && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);

/** All arrays must come from bounded, authorized server snapshots. Browser
 * choices are only proposals; this function never trusts an LLM target ID. */
export function inspectAmuxResolutionChoices(input: {
  nodes: readonly AmuxAnalysisNode[];
  cards: readonly AmuxAnalysisCard[];
  nodeChoices: readonly AmuxNodeResolutionChoice[];
  cardChoices: readonly AmuxCardResolutionChoice[];
  existingNodes: readonly AmuxHierarchySnapshotNode[];
  existingCards: readonly AmuxExistingResolutionCard[];
}): AmuxResolutionInspection {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.cards) ||
      !Array.isArray(input.nodeChoices) || !Array.isArray(input.cardChoices) ||
      !Array.isArray(input.existingNodes) || !Array.isArray(input.existingCards) ||
      input.nodes.length > 40 || input.cards.length > 40 ||
      input.nodeChoices.length > 40 || input.cardChoices.length > 40 ||
      input.existingNodes.length > 1_000 || input.existingCards.length > 1_000) {
    return { ok: false, code: "invalid_input" };
  }
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!node || !validRef(node.localId) || nodeIds.has(node.localId)) {
      return { ok: false, code: "invalid_input" };
    }
    nodeIds.add(node.localId);
  }
  const rejectedNodes = new Set<string>();
  const acceptedNodeChoices: AmuxHierarchyChoice[] = [];
  const seenNodeChoices = new Set<string>();
  for (const choice of input.nodeChoices) {
    if (!choice || !validRef(choice.proposalLocalId) ||
        !nodeIds.has(choice.proposalLocalId) || seenNodeChoices.has(choice.proposalLocalId)) {
      return { ok: false, code: "invalid_input" };
    }
    seenNodeChoices.add(choice.proposalLocalId);
    if (choice.action === "reject") {
      if (choice.targetRef !== null || choice.targetRevision !== null ||
          choice.targetDigest !== null || !validReason(choice.reason)) {
        return { ok: false, code: "invalid_input" };
      }
      rejectedNodes.add(choice.proposalLocalId);
    } else if (choice.action === "create" || choice.action === "select_existing") {
      if (choice.reason !== undefined && choice.reason !== null) {
        return { ok: false, code: "invalid_input" };
      }
      acceptedNodeChoices.push({ proposalLocalId: choice.proposalLocalId,
        action: choice.action, targetRef: choice.targetRef,
        targetRevision: choice.targetRevision, targetDigest: choice.targetDigest });
    } else return { ok: false, code: "invalid_input" };
  }
  if (seenNodeChoices.size !== nodeIds.size) return { ok: false, code: "approval_missing" };
  const hierarchy = inspectAmuxHierarchyChoices({
    proposals: input.nodes.filter((node) => !rejectedNodes.has(node.localId)),
    choices: acceptedNodeChoices, snapshot: input.existingNodes });
  if (!hierarchy.ok) return hierarchy;
  const nodePlans = new Map(hierarchy.plan.map((entry) => [entry.proposalLocalId, entry]));
  const createdNodeNames = new Set<string>();
  for (const node of input.nodes) {
    if (!nodePlans.has(node.localId) || nodePlans.get(node.localId)?.action !== "create") continue;
    const name = `${node.level}\0${node.parentRef ?? ""}\0${node.title.normalize("NFC").toLowerCase()}`;
    if (createdNodeNames.has(name)) return { ok: false, code: "duplicate_conflict" };
    createdNodeNames.add(name);
  }
  const existingNodes = new Map(input.existingNodes.map((entry) => [entry.ref, entry]));
  const cards = new Map<string, AmuxAnalysisCard>();
  for (const card of input.cards) {
    if (!card || card.kind !== "card" || !validRef(card.localId) ||
        !validRef(card.featureRef) ||
        (card.parentStoryRef !== null && !validRef(card.parentStoryRef)) ||
        !["story", "task"].includes(card.cardType) || cards.has(card.localId) ||
        nodePlans.has(card.localId)) return { ok: false, code: "invalid_input" };
    cards.set(card.localId, card);
  }
  const targets = new Map<string, AmuxExistingResolutionCard>();
  for (const target of input.existingCards) {
    if (!target || !validRef(target.ref) || targets.has(target.ref) ||
        cards.has(target.ref) || nodePlans.has(target.ref) ||
        target.sourceSystem !== "admin-idea-v4" ||
        !["story", "task"].includes(target.cardType) ||
        (target.cardType === "story" ? !["general", "bug"].includes(String(target.storyKind)) :
          target.storyKind !== null) || !validRef(target.featureRef) ||
        !validRevision(target.revision) || !DIGEST.test(target.contentDigest) ||
        !["backlog", "todo", "doing", "review", "done", "blocked", "cancelled"]
          .includes(target.status)) return { ok: false, code: "invalid_input" };
    targets.set(target.ref, target);
  }
  const choices = new Map<string, AmuxCardResolutionChoice>();
  for (const choice of input.cardChoices) {
    if (!choice || !validRef(choice.proposalLocalId) ||
        !cards.has(choice.proposalLocalId) || choices.has(choice.proposalLocalId) ||
        !["register", "link_existing", "split", "merge", "reject"].includes(choice.action) ||
        !Array.isArray(choice.relatedLocalRefs) || choice.relatedLocalRefs.length > 40 ||
        choice.relatedLocalRefs.some((ref: unknown) => !validRef(ref)) ||
        new Set(choice.relatedLocalRefs).size !== choice.relatedLocalRefs.length ||
        (choice.reason !== null && !validReason(choice.reason)) ||
        (choice.action === "link_existing"
          ? !validRef(choice.targetRef) || !validRevision(choice.targetRevision) ||
            typeof choice.targetDigest !== "string" || !DIGEST.test(choice.targetDigest)
          : choice.targetRef !== null || choice.targetRevision !== null ||
            choice.targetDigest !== null) ||
        (["split", "merge", "reject", "link_existing"].includes(choice.action) &&
          choice.reason === null) ||
        (["register", "link_existing", "reject"].includes(choice.action) &&
          choice.relatedLocalRefs.length !== 0) ||
        (["split", "merge"].includes(choice.action) && choice.relatedLocalRefs.length < 1)) {
      return { ok: false, code: "invalid_input" };
    }
    choices.set(choice.proposalLocalId, choice);
  }
  if (choices.size !== cards.size) return { ok: false, code: "approval_missing" };
  const cardName = (card: AmuxAnalysisCard) => `${card.cardType}\0${card.storyKind ?? ""}\0${
    card.featureRef}\0${card.title.normalize("NFC").toLowerCase()}`;
  const proposedNameCounts = new Map<string, number>();
  for (const card of input.cards) if (choices.get(card.localId)?.action === "register") {
    const name = cardName(card);
    proposedNameCounts.set(name, (proposedNameCounts.get(name) ?? 0) + 1);
  }
  const plan: AmuxResolutionPlan["cards"] = [];
  const linkedTargets = new Set<string>();
  for (const card of input.cards) {
    const choice = choices.get(card.localId)!;
    const featurePlan = nodePlans.get(card.featureRef);
    const featureNode = existingNodes.get(card.featureRef);
    const feature = featurePlan
      ? { kind: featurePlan.action === "create" ? "proposed_create" : "existing",
          ref: featurePlan.resolvedRef } as const
      : featureNode?.level === "feature" && featureNode.state === "active"
        ? { kind: "existing", ref: featureNode.ref } as const : null;
    if (choice.action !== "reject" &&
        (!feature || (featurePlan && featurePlan.level !== "feature"))) {
      return { ok: false, code: "hierarchy_conflict" };
    }
    let parentStory: AmuxResolutionPlan["cards"][number]["parentStory"] = null;
    if (choice.action !== "reject" && card.parentStoryRef !== null) {
      const proposedParent = cards.get(card.parentStoryRef);
      const existingParent = targets.get(card.parentStoryRef);
      const parentChoice = choices.get(card.parentStoryRef);
      if (card.cardType !== "task" || proposedParent &&
          (proposedParent.cardType !== "story" || parentChoice?.action !== "register" ||
            proposedParent.featureRef !== card.featureRef) ||
          existingParent && (existingParent.cardType !== "story" ||
            existingParent.status !== "backlog" ||
            feature?.kind !== "existing" || existingParent.featureRef !== feature?.ref)) {
        return { ok: false, code: "hierarchy_conflict" };
      }
      if (proposedParent) parentStory = { kind: "proposed_register", ref: proposedParent.localId };
      else if (existingParent) parentStory = { kind: "existing", ref: existingParent.ref };
      else return { ok: false, code: "hierarchy_conflict" };
    }
    let target: AmuxResolutionPlan["cards"][number]["target"] = null;
    if (choice.action === "link_existing") {
      const found = targets.get(choice.targetRef!);
      if (!found || found.revision !== choice.targetRevision ||
          found.contentDigest !== choice.targetDigest || found.status === "cancelled") {
        return { ok: false, code: "snapshot_conflict" };
      }
      if (found.cardType !== card.cardType || found.storyKind !== card.storyKind ||
          feature?.kind !== "existing" || found.featureRef !== feature?.ref ||
          linkedTargets.has(found.ref) || found.ref === card.parentStoryRef) {
        return { ok: false, code: "duplicate_conflict" };
      }
      linkedTargets.add(found.ref);
      target = { ref: found.ref, revision: found.revision, digest: found.contentDigest };
    }
    if (choice.action === "register") {
      if ((card.duplicateCandidateRefs.length > 0 ||
          (proposedNameCounts.get(cardName(card)) ?? 0) > 1) &&
          choice.reason === null) return { ok: false, code: "duplicate_conflict" };
    }
    if (choice.action === "split" || choice.action === "merge") {
      if (choice.relatedLocalRefs.includes(card.localId) ||
          choice.relatedLocalRefs.some((ref) => !cards.has(ref))) {
        return { ok: false, code: "derivation_required" };
      }
    }
    plan.push({ proposalLocalId: card.localId, action: choice.action,
      feature: choice.action === "reject" ? null : feature, parentStory, target,
      relatedLocalRefs: [...choice.relatedLocalRefs],
      requiresDerivedUnit: choice.action === "split" || choice.action === "merge" });
  }
  return { ok: true, plan: { nodes: hierarchy,
    rejectedNodes: [...rejectedNodes], cards: plan } };
}
