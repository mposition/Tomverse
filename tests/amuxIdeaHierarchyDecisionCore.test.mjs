import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxHierarchyChoices } from "../lib/amux/ideaHierarchyDecisionCore.ts";

const digest = (char) => char.repeat(64);
const node = (localId, level, parentRef) => ({
  kind: "node", localId, level, parentRef, title: localId,
  description: "Proposal", sourceRefIds: ["confirmed-source"],
});
const existing = (ref, level, parentRef, revision, char) => ({
  ref, level, parentRef, revision, contentDigest: digest(char), state: "active",
});
const create = (proposalLocalId) => ({
  proposalLocalId, action: "create", targetRef: null, targetRevision: null, targetDigest: null,
});
const select = (proposalLocalId, targetRef, targetRevision, char) => ({
  proposalLocalId, action: "select_existing", targetRef,
  targetRevision, targetDigest: digest(char),
});

test("each new Initiative, Epic, and Feature needs its own owner choice", () => {
  const proposals = [
    node("c0:node-0", "initiative", null),
    node("c0:node-1", "epic", "c0:node-0"),
    node("c0:node-2", "feature", "c0:node-1"),
  ];
  const result = inspectAmuxHierarchyChoices({
    proposals, choices: proposals.map((item) => create(item.localId)), snapshot: [],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.plan.map((entry) => entry.parent), [
      null,
      { kind: "proposed_create", ref: "c0:node-0" },
      { kind: "proposed_create", ref: "c0:node-1" },
    ]);
    assert.equal(result.plan.every((entry) => entry.baseDigest === null), true);
  }
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals, choices: [create("c0:node-0"), create("c0:node-1")], snapshot: [],
  }), { ok: false, code: "approval_missing" });
});

test("existing-path choices bind parent relation, revision, digest, and active state", () => {
  const snapshot = [
    existing("i1", "initiative", null, 3, "a"),
    existing("e1", "epic", "i1", 2, "b"),
    existing("f1", "feature", "e1", 7, "c"),
  ];
  const proposals = [
    node("c0:node-0", "initiative", null),
    node("c0:node-1", "epic", "c0:node-0"),
    node("c0:node-2", "feature", "c0:node-1"),
  ];
  const choices = [
    select("c0:node-0", "i1", 3, "a"),
    select("c0:node-1", "e1", 2, "b"),
    select("c0:node-2", "f1", 7, "c"),
  ];
  const result = inspectAmuxHierarchyChoices({ proposals, choices, snapshot });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.plan.map((entry) => entry.resolvedRef), ["i1", "e1", "f1"]);
    assert.deepEqual(result.plan[2].parent, { kind: "existing", ref: "e1" });
  }
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals, choices: [choices[0], { ...choices[1], targetRevision: 1 }, choices[2]], snapshot,
  }), { ok: false, code: "snapshot_conflict" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals, choices: [choices[0], { ...choices[1], targetDigest: digest("d") }, choices[2]], snapshot,
  }), { ok: false, code: "snapshot_conflict" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals, choices, snapshot: snapshot.map((item) => item.ref === "e1" ? { ...item, state: "archived" } : item),
  }), { ok: false, code: "snapshot_conflict" });
});

test("a selected child cannot silently move to a new or different parent", () => {
  const proposals = [
    node("c0:node-0", "initiative", null),
    node("c0:node-1", "epic", "c0:node-0"),
  ];
  const snapshot = [
    existing("i1", "initiative", null, 0, "a"),
    existing("i2", "initiative", null, 0, "b"),
    existing("e1", "epic", "i2", 0, "c"),
  ];
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals, choices: [select("c0:node-0", "i1", 0, "a"), select("c0:node-1", "e1", 0, "c")], snapshot,
  }), { ok: false, code: "hierarchy_conflict" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals, choices: [create("c0:node-0"), select("c0:node-1", "e1", 0, "c")], snapshot,
  }), { ok: false, code: "hierarchy_conflict" });
});

test("multiple proposals cannot silently merge into one existing identity", () => {
  const proposals = [node("c0:node-0", "initiative", null), node("c1:node-0", "initiative", null)];
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals,
    choices: [select("c0:node-0", "i1", 1, "a"), select("c1:node-0", "i1", 1, "a")],
    snapshot: [existing("i1", "initiative", null, 1, "a")],
  }), { ok: false, code: "hierarchy_conflict" });
});

test("wrong level, duplicate choice, and unapproved parent fail closed", () => {
  const proposal = node("c0:node-0", "feature", "e1");
  const snapshot = [existing("e1", "epic", "i1", 1, "a")];
  assert.equal(inspectAmuxHierarchyChoices({ proposals: [proposal], choices: [create(proposal.localId)], snapshot }).ok, true);
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [proposal], choices: [create(proposal.localId), create(proposal.localId)], snapshot,
  }), { ok: false, code: "invalid_input" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [{ ...proposal, parentRef: "missing" }], choices: [create(proposal.localId)], snapshot,
  }), { ok: false, code: "hierarchy_conflict" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [proposal], choices: [select(proposal.localId, "e1", 1, "a")], snapshot,
  }), { ok: false, code: "hierarchy_conflict" });
});

test("archived, wrong-level, and proposed wrong-level parents cannot enter a plan", () => {
  const feature = node("c0:node-0", "feature", "e1");
  const choice = create(feature.localId);
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [feature], choices: [choice],
    snapshot: [{ ...existing("e1", "epic", "i1", 1, "a"), state: "archived" }],
  }), { ok: false, code: "hierarchy_conflict" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [feature], choices: [choice],
    snapshot: [existing("e1", "initiative", null, 1, "a")],
  }), { ok: false, code: "hierarchy_conflict" });
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [node("c0:node-1", "initiative", null),
      node("c0:node-2", "feature", "c0:node-1")],
    choices: [create("c0:node-1"), create("c0:node-2")], snapshot: [],
  }), { ok: false, code: "hierarchy_conflict" });
});

test("selecting a child does not silently change its direct existing parent", () => {
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [node("c0:node-0", "feature", "e1")],
    choices: [select("c0:node-0", "f1", 2, "c")],
    snapshot: [existing("e1", "epic", "i1", 1, "a"),
      existing("e2", "epic", "i1", 1, "b"), existing("f1", "feature", "e2", 2, "c")],
  }), { ok: false, code: "hierarchy_conflict" });
});

test("colliding identities, unknown choices, and malformed choice bindings fail closed", () => {
  const proposal = node("c0:node-0", "initiative", null);
  const snapshot = [existing("i1", "initiative", null, 1, "a")];
  const inspect = (choices, selectedSnapshot = snapshot) =>
    inspectAmuxHierarchyChoices({ proposals: [proposal], choices, snapshot: selectedSnapshot });
  assert.deepEqual(inspect([create(proposal.localId)],
    [existing(proposal.localId, "initiative", null, 1, "a")]), { ok: false, code: "invalid_input" });
  assert.deepEqual(inspect([create("unknown")]), { ok: false, code: "invalid_input" });
  for (const choice of [
    { ...create(proposal.localId), targetRef: "i1" },
    { ...select(proposal.localId, "i1", 1, "a"), targetDigest: "A".repeat(64) },
    select(proposal.localId, "i1", -1, "a"),
    select(proposal.localId, "i1", 0.5, "a"),
    select(proposal.localId, "i1", Number.MAX_SAFE_INTEGER + 1, "a"),
    { ...create(proposal.localId), action: "auto_approve" },
  ]) assert.deepEqual(inspect([choice]), { ok: false, code: "invalid_input" });
  for (const invalidProposal of [
    node("c0:node-0", "initiative", "i1"),
    node("c0:node-0", "epic", null),
    node("c0:node-0", "feature", null),
  ]) assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [invalidProposal], choices: [create(invalidProposal.localId)], snapshot,
  }), { ok: false, code: "invalid_input" });
});

test("child-first input is order independent and still rejects a stale parent", () => {
  const initiative = node("c0:node-0", "initiative", null);
  const epic = node("c0:node-1", "epic", initiative.localId);
  const snapshot = [existing("i1", "initiative", null, 3, "a")];
  const choices = [select(initiative.localId, "i1", 3, "a"), create(epic.localId)];
  const childFirst = inspectAmuxHierarchyChoices({ proposals: [epic, initiative], choices, snapshot });
  const parentFirst = inspectAmuxHierarchyChoices({ proposals: [initiative, epic], choices, snapshot });
  assert.equal(childFirst.ok, true);
  assert.equal(parentFirst.ok, true);
  if (childFirst.ok && parentFirst.ok) {
    const byId = (result) => new Map(result.plan.map((entry) => [entry.proposalLocalId, entry]));
    assert.deepEqual(byId(childFirst), byId(parentFirst));
  }
  assert.deepEqual(inspectAmuxHierarchyChoices({
    proposals: [epic, initiative],
    choices: [select(initiative.localId, "i1", 2, "a"), create(epic.localId)], snapshot,
  }), { ok: false, code: "snapshot_conflict" });
});
