import {
  type AmuxPermittedNodeTarget,
  type AmuxPermittedTargetRef,
  amuxPermittedTargetRefSafe,
} from "./ideaAnalysisChunkCore.ts";

// Re-exported: the stored-page reader lives beside the parser it feeds.
export { amuxStoredPageExistingNodeTargets } from "./ideaAnalysisChunkCore.ts";

/**
 * Owner decision 2026-11-22 (docs/policy/amux-intake.md): an analysis first
 * reuses the existing Initiative / Epic / Feature hierarchy. These are the
 * existing nodes an analysis page is given as permitted targets, so the model
 * can attach Stories and Tasks to an existing Feature or put a new Feature
 * under an existing Epic. Whether an idea fits a node is the model's
 * judgement; nothing here scores similarity. Pure: the service reads and
 * decrypts the rows.
 */

export type AmuxExistingHierarchyNode = {
  id: string;
  level: "initiative" | "epic" | "feature";
  parentId: string | null;
  /** The decrypted, digest-verified title. */
  title: string;
  displayPrefix: string | null;
  archived: boolean;
};

const LEVELS = ["initiative", "epic", "feature"] as const;

/**
 * Every active node as a permitted target, parents first and then by title.
 * There is no count limit (owner direction 2026-11-15: no artificial limits in
 * AMUX's internal flow); the prompt's one safety ceiling still applies. A node
 * whose stored text a prompt may not carry, or whose stored row does not obey
 * the hierarchy, is left out instead of holding every analysis.
 */
export function amuxExistingHierarchyTargets(
  nodes: readonly AmuxExistingHierarchyNode[],
): AmuxPermittedNodeTarget[] {
  const seen = new Set<string>();
  const targets: AmuxPermittedNodeTarget[] = [];
  for (const node of nodes) {
    if (node.archived || seen.has(node.id) || !LEVELS.includes(node.level)) continue;
    const target: AmuxPermittedNodeTarget = {
      ref: node.id, kind: "node", level: node.level,
      title: node.title.replace(/\s+/g, " ").trim(),
      parentRef: node.level === "initiative" ? null : node.parentId,
      displayPrefix: node.level === "feature" ? node.displayPrefix : null,
    };
    if (!amuxPermittedTargetRefSafe(target, 0)) continue;
    seen.add(node.id);
    targets.push(target);
  }
  return targets.sort((left, right) =>
    LEVELS.indexOf(left.level) - LEVELS.indexOf(right.level) ||
    (left.title! < right.title! ? -1 : left.title! > right.title! ? 1 : 0) ||
    (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}

/** The ids of the existing nodes in a target list. */
export const amuxExistingNodeIds = (targets: readonly AmuxPermittedTargetRef[]): Set<string> =>
  new Set(targets.flatMap((target) => target.kind === "node" &&
    Object.hasOwn(target, "title") ? [target.ref] : []));
