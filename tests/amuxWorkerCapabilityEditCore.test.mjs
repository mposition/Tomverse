// Orchestration policy version 35, section 2 (stage R2a, "Admin 편집";
// version 36): the owner's capability edit form. The form describes exactly
// one capability, and its refusal preview is the store's own rule.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amuxWorkerCapabilityRefusal,
} from "../lib/amux/workerCapabilityCore.ts";
import {
  amuxToggleListValue,
  amuxWorkerCapabilityFormChanges,
  amuxWorkerCapabilityFormFromRow,
  amuxWorkerCapabilityFormRefusal,
  amuxWorkerCapabilityFromForm,
} from "../lib/amux/workerCapabilityEditCore.ts";

const row = (overrides = {}) => ({
  workerName: "claude-chore",
  desiredState: "active",
  roleCeiling: "chore",
  current: null,
  proposed: null,
  refusal: null,
  same: false,
  ...overrides,
});
const recorded = {
  revision: 4,
  capability: {
    model: "claude-opus-5-5",
    routingTags: ["chore", "tests"],
    toolCapabilities: ["git", "shell"],
    v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] },
  },
  changedAt: "2026-10-18T00:00:00.000Z",
};

test("a form is filled from what is recorded, and describes it back unchanged", () => {
  const form = amuxWorkerCapabilityFormFromRow(row({ current: recorded }));
  assert.equal(form.expectedRevision, 4);
  assert.equal(form.tools, "git, shell");
  assert.equal(form.v22Enabled, true);
  assert.deepEqual(amuxWorkerCapabilityFromForm(form), recorded.capability);
  assert.equal(amuxWorkerCapabilityFormChanges(row({ current: recorded }), form), false);
});

test("with nothing recorded the form is empty against revision 0", () => {
  const form = amuxWorkerCapabilityFormFromRow(row());
  assert.equal(form.expectedRevision, 0);
  assert.deepEqual(amuxWorkerCapabilityFromForm(form), { model: null, routingTags: [], toolCapabilities: [], v22: null });
});

test("blank model is no model, tools split on commas, and an unchecked profile is none", () => {
  const form = {
    ...amuxWorkerCapabilityFormFromRow(row({ current: recorded })),
    model: "   ",
    tools: " shell , ,git,shell ",
    v22Enabled: false,
  };
  assert.deepEqual(amuxWorkerCapabilityFromForm(form), {
    model: null,
    routingTags: ["chore", "tests"],
    toolCapabilities: ["git", "shell"],
    v22: null,
  });
  assert.equal(amuxWorkerCapabilityFormChanges(row({ current: recorded }), form), true);
});

test("the refusal preview is the store's rule for this worker's ceiling and provider", () => {
  const base = amuxWorkerCapabilityFormFromRow(row());
  for (const [tags, expected] of [
    [[], "tags_empty"],
    [["implementation"], "tag_above_ceiling"],
    [["chore"], null],
  ]) {
    const form = { ...base, routingTags: tags };
    assert.equal(amuxWorkerCapabilityFormRefusal(row(), form), expected, tags.join(","));
    const registration = { workerName: "claude-chore", providerClass: "claude", roleCeiling: "chore", desiredState: "active", revision: 0 };
    assert.equal(amuxWorkerCapabilityFormRefusal(row(), form), amuxWorkerCapabilityRefusal(registration, amuxWorkerCapabilityFromForm(form)));
  }
  assert.equal(amuxWorkerCapabilityFormRefusal(row({ desiredState: "retired" }), { ...base, routingTags: ["chore"] }), "retired");
  assert.equal(amuxWorkerCapabilityFormRefusal(row({ workerName: "not a worker" }), { ...base, routingTags: ["chore"] }), "not_registered");
});

test("toggling keeps a list sorted and unique", () => {
  assert.deepEqual(amuxToggleListValue(["tests"], "chore", true), ["chore", "tests"]);
  assert.deepEqual(amuxToggleListValue(["chore", "tests"], "chore", true), ["chore", "tests"]);
  assert.deepEqual(amuxToggleListValue(["chore", "tests"], "chore", false), ["tests"]);
});
