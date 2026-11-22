import assert from "node:assert/strict";
import { test } from "node:test";

import { amuxHierarchyNodeNumber, projectAmuxCardHierarchy } from
  "../lib/amux/cardHierarchyCore.ts";

// Owner request 2026-11-21: a Task card shows Initiative > Epic > Feature >
// Story > Task, and still reads right without a Story or with archived parents.

const node = (id, level, parentId, extra = {}) => ({ id, level, parentId,
  state: "active", displayPrefix: null, title: `${level} title`, value: 3, ...extra });
const initiative = node("11111111-aaaa-4aaa-8aaa-000000000001", "initiative", null, { value: 4 });
const epic = node("22222222-bbbb-4bbb-8bbb-000000000002", "epic", initiative.id);
const feature = node("33333333-cccc-4ccc-8ccc-000000000003", "feature", epic.id,
  { displayPrefix: "AMUX-CRAWL", value: 4 });
const story = { id: "story-0001", cardType: "story", displayKey: "AMUX-CRAWL-001",
  status: "in_progress", archived: false, title: "Bots can read public pages",
  parentFeatureNodeId: feature.id, parentStoryCardId: null, metric: 4,
  progress: { done: 1, total: 3 } };
const task = (extra = {}) => ({ id: "task-0002", cardType: "task",
  displayKey: "AMUX-CRAWL-002", status: "todo", archived: false,
  title: "Allow AI search bots in robots.txt", parentFeatureNodeId: feature.id,
  parentStoryCardId: story.id, metric: 3, ...extra });

test("a Task under a Story reads all five levels, top down, ending at itself", () => {
  const steps = projectAmuxCardHierarchy({ card: task(), story, feature, epic, initiative });
  assert.deepEqual(steps.map((step) => [step.kind, step.level]), [
    ["node", "initiative"], ["node", "epic"], ["node", "feature"],
    ["card", "story"], ["card", "task"]]);
  assert.deepEqual(steps[0], { kind: "node", level: "initiative", id: initiative.id,
    title: "initiative title", number: "#111111", archived: false, value: 4,
    weight: 4, editable: true });
  assert.equal(steps[1].weight, 3);
  assert.equal(steps[2].number, "AMUX-CRAWL");
  assert.equal(steps[2].weight, 2);
  assert.deepEqual(steps[3], { kind: "card", level: "story", id: story.id,
    title: story.title, number: "AMUX-CRAWL-001", status: "in_progress",
    archived: false, metric: 4, current: false, progress: { done: 1, total: 3 } });
  assert.equal(steps[4].current, true);
  // Progress belongs to the Story step only.
  assert.equal(steps[4].progress, null);
  assert.equal(steps[4].metric, 3);
});

test("a Feature-direct Task keeps an empty Story step so the line keeps its shape", () => {
  const steps = projectAmuxCardHierarchy({
    card: task({ parentStoryCardId: null }), story: null, feature, epic, initiative });
  assert.deepEqual(steps[3], { kind: "missing", level: "story", reason: "no_story" });
  assert.equal(steps.length, 5);
});

test("a Story the reader could not find is unavailable, not silently dropped", () => {
  const steps = projectAmuxCardHierarchy({ card: task(), story: null,
    feature, epic, initiative });
  assert.deepEqual(steps[3], { kind: "missing", level: "story", reason: "unavailable" });
  // A Task's Feature can come from its Story when the Task names none.
  const viaStory = projectAmuxCardHierarchy({
    card: task({ parentFeatureNodeId: null }), story, feature, epic, initiative });
  assert.equal(viaStory[2].id, feature.id);
});

test("archived parents show, marked and read-only; an unreadable title stays null", () => {
  const steps = projectAmuxCardHierarchy({ card: task({ status: "done" }), story,
    feature: { ...feature, state: "archived", title: null, value: null },
    epic: { ...epic, state: "archived" }, initiative });
  assert.equal(steps[0].archived, false);
  assert.equal(steps[0].editable, true);
  assert.equal(steps[1].archived, true);
  assert.equal(steps[1].editable, false);
  assert.equal(steps[2].archived, true);
  assert.equal(steps[2].title, null);
  assert.equal(steps[2].value, null);
  assert.equal(steps[4].status, "done");
});

test("a broken chain shows the missing level instead of a wrong parent", () => {
  const strayEpic = { ...epic, id: "99999999-0000-4000-8000-000000000009" };
  const steps = projectAmuxCardHierarchy({ card: task(), story, feature,
    epic: strayEpic, initiative });
  assert.deepEqual(steps[1], { kind: "missing", level: "epic", reason: "unavailable" });
  assert.deepEqual(steps[0], { kind: "missing", level: "initiative", reason: "unavailable" });
  // A node of the wrong level never fills a step.
  const wrongLevel = projectAmuxCardHierarchy({ card: task(), story,
    feature: { ...feature, level: "epic" }, epic, initiative });
  assert.equal(wrongLevel[2].kind, "missing");
});

test("a Story card ends at itself; legacy and unplaced cards have no line", () => {
  const steps = projectAmuxCardHierarchy({ card: { ...story }, story: null,
    feature, epic, initiative });
  assert.deepEqual(steps.map((step) => step.level),
    ["initiative", "epic", "feature", "story"]);
  assert.equal(steps[3].current, true);
  assert.equal(projectAmuxCardHierarchy({ card: task({ cardType: null }),
    story: null, feature, epic, initiative }), null);
  assert.equal(projectAmuxCardHierarchy({ card: task({ parentFeatureNodeId: null,
    parentStoryCardId: null }), story: null, feature: null, epic: null,
  initiative: null }), null);
});

test("node numbers: a Feature's prefix, otherwise a short id", () => {
  assert.equal(amuxHierarchyNodeNumber({ id: "7f3a12e0-1111-4111-8111-1", displayPrefix: null }), "#7f3a12");
  assert.equal(amuxHierarchyNodeNumber({ id: "x", displayPrefix: "AMUX-CRAWL" }), "AMUX-CRAWL");
});

test("owner direction 2026-11-21: a Story off the board shows its Tasks' progress on the line", () => {
  // A Story card opened from the line ends at itself, with its progress.
  const own = projectAmuxCardHierarchy({ card: { ...story, progress: { done: 0, total: 0 } },
    story: null, feature, epic, initiative });
  assert.deepEqual(own[3].progress, { done: 0, total: 0 });
  // A Story the reader gave no progress for shows none, never a guess.
  const bare = projectAmuxCardHierarchy({ card: task(), story: { ...story, progress: undefined },
    feature, epic, initiative });
  assert.equal(bare[3].progress, null);
  // The Story step stays a link: not the current card, so it opens the Story.
  assert.equal(bare[3].current, false);
});
