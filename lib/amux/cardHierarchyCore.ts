/** Owner request 2026-11-21: a Task (or Story) card shows the line it belongs
 * to, Initiative > Epic > Feature > Story > Task, with each step's name,
 * number, state and value, and a way to open it. Pure projection: the reader
 * (adminExecutionRead.ts) supplies decrypted titles and bound assessments. */

export type AmuxHierarchyNodeLevel = "initiative" | "epic" | "feature";
export type AmuxHierarchyCardLevel = "story" | "task";

export type AmuxHierarchyNodeInput = {
  id: string; level: string; parentId: string | null; state: string;
  displayPrefix: string | null; title: string | null;
  /** The value of the latest assessment bound to the node's revision. */
  value: number | null;
};

export type AmuxHierarchyCardInput = {
  id: string; cardType: string | null; displayKey: string | null;
  status: string; archived: boolean; title: string | null;
  parentFeatureNodeId: string | null; parentStoryCardId: string | null;
  /** Story impact or Task contribution, bound to the card's revision. */
  metric: number | null;
  /** A Story's open Tasks: done of total. Stories are off the board's lanes
   * (owner direction 2026-11-21), so their progress shows here. */
  progress?: { done: number; total: number } | null;
};

export type AmuxHierarchyStep =
  | { kind: "node"; level: AmuxHierarchyNodeLevel; id: string;
      title: string | null; number: string; archived: boolean;
      value: number | null; weight: number; editable: boolean }
  | { kind: "card"; level: AmuxHierarchyCardLevel; id: string;
      title: string | null; number: string | null; status: string;
      archived: boolean; metric: number | null; current: boolean;
      progress: { done: number; total: number } | null }
  | { kind: "missing"; level: AmuxHierarchyNodeLevel | AmuxHierarchyCardLevel;
      reason: "no_story" | "unavailable" };

const NODE_WEIGHT: Record<AmuxHierarchyNodeLevel, number> = {
  initiative: 4, epic: 3, feature: 2,
};

/** Initiatives and Epics carry no display number; a short id stands in. */
export const amuxHierarchyNodeNumber = (node: Pick<AmuxHierarchyNodeInput,
  "id" | "displayPrefix">) => node.displayPrefix ?? `#${node.id.replace(/-/g, "").slice(0, 6)}`;

function nodeStep(level: AmuxHierarchyNodeLevel,
  node: AmuxHierarchyNodeInput | null): AmuxHierarchyStep {
  if (!node || node.level !== level) return { kind: "missing", level, reason: "unavailable" };
  const archived = node.state !== "active";
  return { kind: "node", level, id: node.id, title: node.title,
    number: amuxHierarchyNodeNumber(node), archived, value: node.value,
    weight: NODE_WEIGHT[level], editable: !archived };
}

function cardStep(level: AmuxHierarchyCardLevel, card: AmuxHierarchyCardInput,
  current: boolean): AmuxHierarchyStep {
  return { kind: "card", level, id: card.id, title: card.title,
    number: card.displayKey, status: card.status,
    archived: card.archived, metric: card.metric, current,
    progress: level === "story" ? card.progress ?? null : null };
}

/** Steps from the top down, ending at the card itself. Null for a card with
 * no v4 place (a legacy card, or one of neither Story nor Task type). A
 * Feature-direct Task keeps an empty Story step so the line keeps its shape. */
export function projectAmuxCardHierarchy(input: {
  card: AmuxHierarchyCardInput; story: AmuxHierarchyCardInput | null;
  feature: AmuxHierarchyNodeInput | null; epic: AmuxHierarchyNodeInput | null;
  initiative: AmuxHierarchyNodeInput | null;
}): AmuxHierarchyStep[] | null {
  const { card, story } = input;
  if (card.cardType !== "task" && card.cardType !== "story") return null;
  const featureId = card.parentFeatureNodeId ?? story?.parentFeatureNodeId ?? null;
  if (!featureId && !card.parentStoryCardId) return null;
  const feature = input.feature?.id === featureId ? input.feature : null;
  const epic = feature && input.epic?.id === feature.parentId ? input.epic : null;
  const initiative = epic && input.initiative?.id === epic.parentId ?
    input.initiative : null;
  const steps: AmuxHierarchyStep[] = [
    nodeStep("initiative", initiative), nodeStep("epic", epic),
    nodeStep("feature", feature),
  ];
  if (card.cardType === "story") {
    steps.push(cardStep("story", card, true));
    return steps;
  }
  if (!card.parentStoryCardId) {
    steps.push({ kind: "missing", level: "story", reason: "no_story" });
  } else if (!story || story.id !== card.parentStoryCardId || story.cardType !== "story") {
    steps.push({ kind: "missing", level: "story", reason: "unavailable" });
  } else {
    steps.push(cardStep("story", story, false));
  }
  steps.push(cardStep("task", card, true));
  return steps;
}
