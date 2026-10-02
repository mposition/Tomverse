import assert from "node:assert/strict";
import test from "node:test";

import { projectAmuxAdminHierarchy } from "../lib/amux/adminHierarchyCore.ts";

const row = (id, cardType, parentFeatureNodeId, parentStoryCardId = null) => ({
  id, sourceKey: id, kind: cardType ?? "unknown", cardType,
  parentFeatureNodeId, parentStoryCardId, status: "backlog",
});
const nodes = [
  { id: "i1", level: "initiative", parentId: null, state: "active" },
  { id: "e1", level: "epic", parentId: "i1", state: "active" },
  { id: "f1", level: "feature", parentId: "e1", state: "active" },
];

test("AMUX outline places Story tasks and direct Feature tasks without losing legacy cards", () => {
  const items = projectAmuxAdminHierarchy([
    row("task-b", "task", "f1", "story-a"),
    row("legacy", null, null),
    row("task-direct", "task", "f1"),
    row("story-a", "story", "f1"),
  ], nodes);
  assert.deepEqual(items.map(({ kind, id, depth }) => [kind, id, depth]), [
    ["node", "i1", 0], ["node", "e1", 1], ["node", "f1", 2],
    ["card", "story-a", 3], ["card", "task-b", 4],
    ["card", "task-direct", 3], ["unlinked", "unlinked", 0],
    ["card", "legacy", 1],
  ]);
  assert.deepEqual(items.filter((item) => item.kind === "card").map((item) => item.id).sort(),
    ["legacy", "story-a", "task-b", "task-direct"]);
});

test("AMUX outline labels an off-page Story without inventing a card", () => {
  const items = projectAmuxAdminHierarchy([
    row("task-1", "task", "f1", "story-outside"),
    row("task-2", "task", "f1", "story-outside"),
  ], nodes);
  assert.equal(items.filter((item) => item.kind === "outside_page_story").length, 1);
  assert.deepEqual(items.filter((item) => item.kind === "card").map((item) => item.depth), [4, 4]);
});

test("missing or cross-feature ancestors keep every card in the unlinked group", () => {
  const items = projectAmuxAdminHierarchy([
    row("missing-feature", "story", "not-found"),
    row("wrong-story", "task", "f1", "other-feature-story"),
    row("other-feature-story", "story", "f2"),
  ], [...nodes, { id: "f2", level: "feature", parentId: "e1", state: "active" }]);
  assert.deepEqual(items.filter((item) => item.kind === "card").map((item) => item.id).sort(),
    ["missing-feature", "other-feature-story", "wrong-story"]);
  assert.equal(items.at(-1)?.id, "wrong-story");
  assert.equal(items.some((item) => item.kind === "unlinked"), true);
});
