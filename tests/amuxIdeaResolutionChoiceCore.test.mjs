import assert from "node:assert/strict";
import test from "node:test";

import { amuxV4ResolutionPreviewEnabled, inspectAmuxResolutionChoices } from
  "../lib/amux/ideaResolutionChoiceCore.ts";

const digest = (letter) => letter.repeat(64);
const node = (localId, level, parentRef) => ({ kind: "node", localId,
  level, parentRef, title: localId, description: "Proposal", sourceRefIds: ["operator_idea"] });
const card = (localId, featureRef, overrides = {}) => ({ kind: "card", localId,
  cardType: "story", storyKind: "general", title: localId, problem: "Problem",
  scopeIn: ["One unit"], scopeOut: [], completionCriteria: ["Tested"],
  featureRef, parentStoryRef: null, dependencyRefs: [], duplicateCandidateRefs: [],
  taskRole: null, executionGrade: null, executionBrief: null,
  sourceRefIds: ["operator_idea"], ...overrides });
const createNode = (proposalLocalId) => ({ proposalLocalId, action: "create",
  targetRef: null, targetRevision: null, targetDigest: null });
const selectNode = (proposalLocalId, targetRef, targetRevision, letter) => ({
  proposalLocalId, action: "select_existing", targetRef,
  targetRevision, targetDigest: digest(letter),
});
const existingNode = (ref, level, parentRef, revision, letter) => ({
  ref, level, parentRef, revision, contentDigest: digest(letter), state: "active",
});
const existingCard = (ref, featureRef, overrides = {}) => ({
  ref, sourceSystem: "admin-idea-v4", cardType: "story", storyKind: "general",
  featureRef, revision: 3, contentDigest: digest("d"), status: "backlog", ...overrides,
});
const choice = (proposalLocalId, action = "register", overrides = {}) => ({
  proposalLocalId, action, targetRef: null, targetRevision: null, targetDigest: null,
  relatedLocalRefs: [], reason: null, ...overrides,
});
const base = (overrides = {}) => ({
  nodes: [node("c0:node-0", "feature", "e1")],
  cards: [card("c0:card-0", "c0:node-0")],
  nodeChoices: [selectNode("c0:node-0", "f1", 4, "c")],
  cardChoices: [choice("c0:card-0")],
  existingNodes: [existingNode("i1", "initiative", null, 1, "a"),
    existingNode("e1", "epic", "i1", 2, "b"),
    existingNode("f1", "feature", "e1", 4, "c")],
  existingCards: [existingCard("s1", "f1")],
  ...overrides,
});

test("A08 preview requires its dedicated environment value", () => {
  assert.equal(amuxV4ResolutionPreviewEnabled("enabled"), true);
  assert.equal(amuxV4ResolutionPreviewEnabled(undefined), false);
});

test("owner may preview a new Story under an exact selected Feature", () => {
  const inspected = inspectAmuxResolutionChoices(base());
  assert.equal(inspected.ok, true);
  if (inspected.ok) assert.deepEqual(inspected.plan.cards[0], {
    proposalLocalId: "c0:card-0", action: "register",
    feature: { kind: "existing", ref: "f1" }, parentStory: null,
    target: null, relatedLocalRefs: [], requiresDerivedUnit: false,
  });
});

test("selection binds exact v4 card identity, version, digest and Feature", () => {
  const selected = choice("c0:card-0", "link_existing", {
    targetRef: "s1", targetRevision: 3, targetDigest: digest("d"),
    reason: "Same completed unit",
  });
  assert.equal(inspectAmuxResolutionChoices(base({ cardChoices: [selected] })).ok, true);
  for (const target of [
    { revision: 4 }, { contentDigest: digest("e") }, { featureRef: "f2" },
    { status: "cancelled" }, { sourceSystem: "codex-conversation" },
  ]) {
    const result = inspectAmuxResolutionChoices(base({ cardChoices: [selected],
      existingCards: [existingCard("s1", "f1", target)] }));
    assert.equal(result.ok, false, JSON.stringify(target));
  }
  assert.equal(inspectAmuxResolutionChoices(base({
    nodeChoices: [createNode("c0:node-0")], cardChoices: [selected],
  })).ok, false);
});

test("missing card decision, duplicate candidate and silent link are refused", () => {
  assert.deepEqual(inspectAmuxResolutionChoices(base({ cardChoices: [] })),
    { ok: false, code: "approval_missing" });
  assert.deepEqual(inspectAmuxResolutionChoices(base({
    cards: [card("c0:card-0", "c0:node-0", { duplicateCandidateRefs: ["s1"] })],
  })), { ok: false, code: "duplicate_conflict" });
  assert.deepEqual(inspectAmuxResolutionChoices(base({ cardChoices: [
    choice("c0:card-0", "link_existing", {
      targetRef: "s1", targetRevision: 3, targetDigest: digest("d"),
    }),
  ] })), { ok: false, code: "invalid_input" });
});

test("Task parent may be registered Story or existing same-Feature Story", () => {
  const story = card("c0:card-0", "c0:node-0");
  const task = card("c0:card-1", "c0:node-0", {
    cardType: "task", storyKind: null, parentStoryRef: story.localId,
    taskRole: "implement", executionGrade: "routine", executionBrief: "Implement one behavior",
  });
  const input = base({ cards: [story, task], cardChoices: [
    choice(story.localId), choice(task.localId),
  ] });
  const result = inspectAmuxResolutionChoices(input);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.plan.cards[1].parentStory,
    { kind: "proposed_register", ref: story.localId });
  assert.equal(inspectAmuxResolutionChoices({ ...input,
    cardChoices: [choice(story.localId, "reject", { reason: "Do not use" }),
      choice(task.localId)],
  }).ok, false);
  const existingParent = inspectAmuxResolutionChoices(base({
    cards: [{ ...task, parentStoryRef: "s1" }],
    cardChoices: [choice(task.localId)],
  }));
  assert.equal(existingParent.ok, true);
  if (existingParent.ok) assert.deepEqual(existingParent.plan.cards[0].parentStory,
    { kind: "existing", ref: "s1" });
});

test("split and merge explicitly hold original units for new derivation", () => {
  const cards = [card("c0:card-0", "c0:node-0"), card("c0:card-1", "c0:node-0")];
  for (const action of ["split", "merge"]) {
    const result = inspectAmuxResolutionChoices(base({ cards,
      cardChoices: [choice(cards[0].localId, action, {
        relatedLocalRefs: [cards[1].localId], reason: "Overlapping work needs a new unit",
      }), choice(cards[1].localId, "reject", { reason: "Held for derivation" })],
    }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plan.cards[0].requiresDerivedUnit, true);
  }
  assert.deepEqual(inspectAmuxResolutionChoices(base({ cards,
    cardChoices: [choice(cards[0].localId, "split", {
      relatedLocalRefs: ["missing"], reason: "Needs another unit",
    }), choice(cards[1].localId)],
  })), { ok: false, code: "derivation_required" });
});

test("rejecting a node or card needs a reason but not an available parent", () => {
  const rejected = inspectAmuxResolutionChoices(base({
    nodes: [node("c0:node-0", "feature", "missing-epic")],
    cards: [card("c0:card-0", "missing-feature")],
    nodeChoices: [{ ...createNode("c0:node-0"), action: "reject",
      reason: "Incorrect portfolio branch" }],
    cardChoices: [choice("c0:card-0", "reject", { reason: "Out of scope" })],
  }));
  assert.equal(rejected.ok, true);
  if (rejected.ok) {
    assert.deepEqual(rejected.plan.rejectedNodes, ["c0:node-0"]);
    assert.equal(rejected.plan.cards[0].feature, null);
  }
  assert.deepEqual(inspectAmuxResolutionChoices(base({
    nodeChoices: [{ ...createNode("c0:node-0"), action: "reject" }],
  })), { ok: false, code: "invalid_input" });
});

test("same-title local proposals cannot silently create duplicate nodes or cards", () => {
  const nodes = [{ ...node("c0:node-0", "feature", "e1"), title: "Same feature" },
    { ...node("c0:node-1", "feature", "e1"), title: "same feature" }];
  assert.deepEqual(inspectAmuxResolutionChoices(base({ nodes,
    nodeChoices: nodes.map((item) => createNode(item.localId)),
    cards: [], cardChoices: [],
  })), { ok: false, code: "duplicate_conflict" });
  const cards = [card("c0:card-0", "c0:node-0", { title: "Same work" }),
    card("c0:card-1", "c0:node-0", { title: "same work" })];
  assert.deepEqual(inspectAmuxResolutionChoices(base({ cards,
    cardChoices: cards.map((item) => choice(item.localId)),
  })), { ok: false, code: "duplicate_conflict" });
  assert.equal(inspectAmuxResolutionChoices(base({ cards,
    cardChoices: cards.map((item) => choice(item.localId, "register", {
      reason: "Separate acceptance evidence",
    })),
  })).ok, true);
});
