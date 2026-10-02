import type { AmuxAdminCardRow, AmuxAdminHierarchyNode } from "./adminCardList.ts";

export type AmuxAdminHierarchyItem = {
  kind: "node" | "card" | "outside_page_story" | "unlinked";
  id: string;
  depth: number;
  label: string;
  status: string | null;
};

const byId = (left: { id: string }, right: { id: string }) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/** This is an outline of the current card page, not a global hierarchy read.
 * Missing or inconsistent ancestors never make a card disappear. */
export function projectAmuxAdminHierarchy(
  rows: readonly AmuxAdminCardRow[],
  nodes: readonly AmuxAdminHierarchyNode[],
): AmuxAdminHierarchyItem[] {
  const byCardId = new Map(rows.map((row) => [row.id, row]));
  const rendered = new Set<string>();
  const items: AmuxAdminHierarchyItem[] = [];
  const addNode = (node: AmuxAdminHierarchyNode, depth: number) => {
    items.push({ kind: "node", id: node.id, depth,
      label: `${node.level} · ${node.id}`, status: node.state });
  };
  const addCard = (card: AmuxAdminCardRow, depth: number) => {
    if (rendered.has(card.id)) return;
    rendered.add(card.id);
    items.push({ kind: "card", id: card.id, depth,
      label: `${card.cardType ?? card.kind} · ${card.sourceKey ?? card.id}`,
      status: card.status });
  };

  for (const initiative of [...nodes].filter((node) =>
    node.level === "initiative" && node.parentId === null).sort(byId)) {
    const beforeInitiative = items.length;
    addNode(initiative, 0);
    for (const epic of [...nodes].filter((node) =>
      node.level === "epic" && node.parentId === initiative.id).sort(byId)) {
      const beforeEpic = items.length;
      addNode(epic, 1);
      for (const feature of [...nodes].filter((node) =>
        node.level === "feature" && node.parentId === epic.id).sort(byId)) {
        const cards = [...rows].filter((row) => row.parentFeatureNodeId === feature.id);
        if (cards.length === 0) continue;
        addNode(feature, 2);
        const stories = cards.filter((row) => row.cardType === "story" &&
          row.parentStoryCardId === null).sort(byId);
        const tasks = cards.filter((row) => row.cardType === "task").sort(byId);
        for (const story of stories) {
          addCard(story, 3);
          for (const task of tasks.filter((row) => row.parentStoryCardId === story.id)) {
            addCard(task, 4);
          }
        }
        for (const task of tasks.filter((row) => row.parentStoryCardId === null)) {
          addCard(task, 3);
        }
        const outsideIds = [...new Set(tasks.flatMap((task) =>
          task.parentStoryCardId && !byCardId.has(task.parentStoryCardId)
            ? [task.parentStoryCardId] : []))].sort();
        for (const storyId of outsideIds) {
          items.push({ kind: "outside_page_story", id: storyId, depth: 3,
            label: `story · ${storyId}`, status: null });
          for (const task of tasks.filter((row) => row.parentStoryCardId === storyId)) {
            addCard(task, 4);
          }
        }
      }
      if (items.length === beforeEpic + 1) items.splice(beforeEpic, 1);
    }
    if (items.length === beforeInitiative + 1) items.splice(beforeInitiative, 1);
  }
  const remaining = [...rows].filter((row) => !rendered.has(row.id)).sort(byId);
  if (remaining.length > 0) {
    items.push({ kind: "unlinked", id: "unlinked", depth: 0,
      label: "unlinked", status: null });
    for (const card of remaining) addCard(card, 1);
  }
  // Incomplete node reads leave the current page's cards in the unlinked group.
  return items;
}
