import type { AmuxAnalysisNode } from "./ideaAnalysisChunkCore.ts";

/** Structural preflight only. The app must re-read these rows under its own
 * transaction, bind a human approval to a keyed digest, and write canonical
 * audit before any node is created or linked. */
export type AmuxHierarchySnapshotNode = {
  ref: string;
  level: "initiative" | "epic" | "feature";
  parentRef: string | null;
  revision: number;
  contentDigest: string;
  state: "active" | "archived";
};

export type AmuxHierarchyChoice = {
  proposalLocalId: string;
  action: "create" | "select_existing";
  targetRef: string | null;
  targetRevision: number | null;
  targetDigest: string | null;
};

export type AmuxHierarchyPlanEntry = {
  proposalLocalId: string;
  level: AmuxAnalysisNode["level"];
  action: AmuxHierarchyChoice["action"];
  resolvedRef: string;
  parent: { kind: "existing" | "proposed_create"; ref: string } | null;
  baseRevision: number | null;
  baseDigest: string | null;
};

export type AmuxHierarchyDecisionInspection =
  | { ok: true; plan: AmuxHierarchyPlanEntry[] }
  | { ok: false; code: "invalid_input" | "approval_missing" | "snapshot_conflict" | "hierarchy_conflict" };

const REF = /^[A-Za-z0-9:_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const LEVELS = ["initiative", "epic", "feature"] as const;
const validRef = (value: unknown): value is string => typeof value === "string" && REF.test(value);
const validDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A plan is a preview, never an approval receipt or authorization to write. */
export function inspectAmuxHierarchyChoices(input: {
  proposals: readonly AmuxAnalysisNode[];
  choices: readonly AmuxHierarchyChoice[];
  snapshot: readonly AmuxHierarchySnapshotNode[];
}): AmuxHierarchyDecisionInspection {
  if (!input || !Array.isArray(input.proposals) || !Array.isArray(input.choices) ||
      !Array.isArray(input.snapshot) || input.proposals.length > 10_000 ||
      input.choices.length > 10_000 || input.snapshot.length > 10_000) {
    return { ok: false, code: "invalid_input" };
  }
  const proposals = new Map<string, AmuxAnalysisNode>();
  for (const node of input.proposals) {
    if (!node || node.kind !== "node" || !validRef(node.localId) ||
        !LEVELS.includes(node.level) || (node.parentRef !== null && !validRef(node.parentRef)) ||
        (node.level === "initiative") !== (node.parentRef === null) ||
        proposals.has(node.localId)) return { ok: false, code: "invalid_input" };
    proposals.set(node.localId, node);
  }
  const snapshot = new Map<string, AmuxHierarchySnapshotNode>();
  for (const node of input.snapshot) {
    if (!node || !validRef(node.ref) || !LEVELS.includes(node.level) ||
        (node.parentRef !== null && !validRef(node.parentRef)) ||
        (node.level === "initiative") !== (node.parentRef === null) ||
        !validRevision(node.revision) || !validDigest(node.contentDigest) ||
        !["active", "archived"].includes(node.state) || snapshot.has(node.ref) ||
        proposals.has(node.ref)) return { ok: false, code: "invalid_input" };
    snapshot.set(node.ref, node);
  }
  const choices = new Map<string, AmuxHierarchyChoice>();
  for (const choice of input.choices) {
    if (!choice || !validRef(choice.proposalLocalId) || !proposals.has(choice.proposalLocalId) ||
        choices.has(choice.proposalLocalId) || !["create", "select_existing"].includes(choice.action) ||
        (choice.action === "create"
          ? choice.targetRef !== null || choice.targetRevision !== null || choice.targetDigest !== null
          : !validRef(choice.targetRef) || !validRevision(choice.targetRevision) || !validDigest(choice.targetDigest))) {
      return { ok: false, code: "invalid_input" };
    }
    choices.set(choice.proposalLocalId, choice);
  }
  if (choices.size !== proposals.size) return { ok: false, code: "approval_missing" };

  const selected = new Set<string>();
  const plan: AmuxHierarchyPlanEntry[] = [];
  for (const proposal of input.proposals) {
    const choice = choices.get(proposal.localId)!;
    const expectedParentLevel = proposal.level === "epic" ? "initiative" : "epic";
    let parent: AmuxHierarchyPlanEntry["parent"] = null;
    if (proposal.parentRef !== null) {
      const proposedParent = proposals.get(proposal.parentRef);
      if (proposedParent) {
        const parentChoice = choices.get(proposal.parentRef)!;
        parent = parentChoice.action === "create"
          ? { kind: "proposed_create", ref: proposedParent.localId }
          : { kind: "existing", ref: parentChoice.targetRef! };
        if (proposedParent.level !== expectedParentLevel) {
          return { ok: false, code: "hierarchy_conflict" };
        }
      } else {
        const existingParent = snapshot.get(proposal.parentRef);
        if (!existingParent || existingParent.state !== "active" ||
            existingParent.level !== expectedParentLevel) {
          return { ok: false, code: "hierarchy_conflict" };
        }
        parent = { kind: "existing", ref: existingParent.ref };
      }
    }
    if (choice.action === "create") {
      plan.push({ proposalLocalId: proposal.localId, level: proposal.level,
        action: "create", resolvedRef: proposal.localId, parent,
        baseRevision: null, baseDigest: null });
      continue;
    }
    const target = snapshot.get(choice.targetRef!);
    if (!target || target.state !== "active" || target.revision !== choice.targetRevision ||
        target.contentDigest !== choice.targetDigest) {
      return { ok: false, code: "snapshot_conflict" };
    }
    if (selected.has(target.ref) || target.level !== proposal.level ||
        parent?.kind === "proposed_create" || target.parentRef !== (parent?.ref ?? null)) {
      return { ok: false, code: "hierarchy_conflict" };
    }
    selected.add(target.ref);
    plan.push({ proposalLocalId: proposal.localId, level: proposal.level,
      action: "select_existing", resolvedRef: target.ref, parent,
      baseRevision: target.revision, baseDigest: target.contentDigest });
  }
  return { ok: true, plan };
}
