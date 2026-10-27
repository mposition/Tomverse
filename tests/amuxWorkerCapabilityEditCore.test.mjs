// Orchestration policy version 35, section 2 (stage R2a, "Admin 편집";
// version 36): the owner's capability edit form. Since the owner decision of
// 2026-10-27 the form is a role preset, one model and whether AMUX hands the
// worker Tasks; the preset's lists follow the worker's class and ceiling, and
// the refusal preview is the store's own rule.

import assert from "node:assert/strict";
import { test } from "node:test";

import { amuxWorkerCapabilityRefusal } from "../lib/amux/workerCapabilityCore.ts";
import {
  amuxWorkerCapabilityFormChanges,
  amuxWorkerCapabilityFormFromRow,
  amuxWorkerCapabilityFormRefusal,
  amuxWorkerCapabilityFromForm,
  amuxWorkerCapabilityIsCustom,
} from "../lib/amux/workerCapabilityEditCore.ts";
import {
  amuxWorkerDefaultProfilePreset,
  amuxWorkerProfilePresetCapability,
  amuxWorkerProfilePresetOf,
  amuxWorkerProfilePresetsFor,
} from "../lib/amux/workerProfilePresetCore.ts";

const row = (overrides = {}) => ({
  workerName: "claude-impl",
  providerClass: "claude",
  desiredState: "active",
  roleCeiling: "implementation",
  current: null,
  ...overrides,
});
const registrationOf = (r) => ({ workerName: r.workerName, providerClass: r.providerClass,
  roleCeiling: r.roleCeiling, desiredState: r.desiredState, revision: 0 });

test("each preset is the owner's table of 2026-10-27 for a worker that may hold all of it", () => {
  const claude = { providerClass: "claude", roleCeiling: "contract" };
  assert.deepEqual(amuxWorkerProfilePresetCapability(claude, "chore", "claude-haiku-5-5", true), {
    model: "claude-haiku-5-5", routingTags: ["bugfix", "chore", "tests"],
    toolCapabilities: ["repo_read", "repo_write", "test_run"],
    v22: { model: "claude-haiku-5-5", roles: ["investigate"], tools: ["repo_read"] },
  });
  assert.deepEqual(amuxWorkerProfilePresetCapability(claude, "impl", "m", true).v22,
    { model: "m", roles: ["implement", "investigate"], tools: ["repo_read", "repo_write"] });
  assert.deepEqual(amuxWorkerProfilePresetCapability(claude, "contract", "m", true), {
    model: "m", routingTags: ["architecture", "contract", "multi_file", "reasoning", "review", "security"],
    toolCapabilities: ["repo_read", "repo_write", "test_run"],
    v22: { model: "m", roles: ["design", "implement", "investigate", "review"], tools: ["repo_read", "repo_write"] },
  });
  assert.deepEqual(amuxWorkerProfilePresetCapability(claude, "review", "m", true), {
    model: "m", routingTags: ["architecture", "reasoning", "review", "security"], toolCapabilities: ["repo_read"],
    v22: { model: "m", roles: ["investigate", "review"], tools: ["repo_read"] },
  });
  // Not taking Tasks records no one-shot profile; the lists stay.
  assert.equal(amuxWorkerProfilePresetCapability(claude, "impl", "m", false).v22, null);
});

test("presets follow the class and the ceiling, so none asks for what the store refuses", () => {
  assert.deepEqual(amuxWorkerProfilePresetsFor({ providerClass: "claude", roleCeiling: "chore" }), ["chore"]);
  assert.deepEqual(amuxWorkerProfilePresetsFor({ providerClass: "codex", roleCeiling: "contract" }), ["chore", "impl", "contract", "review"]);
  // Copilot and Cursor are unverified and stop at implementation: no contract, no review.
  assert.deepEqual(amuxWorkerProfilePresetsFor({ providerClass: "copilot", roleCeiling: "implementation" }), ["chore", "impl"]);
  assert.equal(amuxWorkerDefaultProfilePreset({ providerClass: "codex", roleCeiling: "contract" }), "contract");
  assert.equal(amuxWorkerDefaultProfilePreset({ providerClass: "cursor", roleCeiling: "implementation" }), "impl");
  // Cursor takes the read roles only: its implementation preset investigates.
  const cursor = amuxWorkerProfilePresetCapability({ providerClass: "cursor", roleCeiling: "implementation" }, "impl", "composer-2.5", true);
  assert.deepEqual(cursor.v22, { model: "composer-2.5", roles: ["investigate"], tools: ["repo_read"] });
  for (const providerClass of ["claude", "codex", "cursor", "copilot"]) {
    for (const roleCeiling of ["chore", "implementation", "contract"]) {
      if ((providerClass === "cursor" || providerClass === "copilot") && roleCeiling === "contract") continue;
      const worker = { providerClass, roleCeiling };
      for (const preset of amuxWorkerProfilePresetsFor(worker)) {
        const model = providerClass === "claude" ? "claude-sonnet-5" : "kimi-k3";
        const capability = amuxWorkerProfilePresetCapability(worker, preset, model, true);
        const registration = { ...worker, workerName: "w", desiredState: "active", revision: 1 };
        assert.equal(amuxWorkerCapabilityRefusal(registration, capability), null, `${providerClass} ${roleCeiling} ${preset}`);
        assert.equal(amuxWorkerProfilePresetOf(worker, capability), preset, `${providerClass} ${roleCeiling} ${preset}`);
      }
    }
  }
});

test("a form is filled from a preset record and describes it back unchanged", () => {
  const capability = amuxWorkerProfilePresetCapability(row(), "impl", "claude-sonnet-5", true);
  const recorded = row({ current: { revision: 4, capability, changedAt: "2026-10-27T00:00:00.000Z" } });
  const form = amuxWorkerCapabilityFormFromRow(recorded);
  assert.deepEqual(form, { workerName: "claude-impl", expectedRevision: 4, preset: "impl", model: "claude-sonnet-5", oneShot: true });
  assert.deepEqual(amuxWorkerCapabilityFromForm(recorded, form), capability);
  assert.equal(amuxWorkerCapabilityFormChanges(recorded, form), false);
  assert.equal(amuxWorkerCapabilityIsCustom(recorded), false);
  // One model is both the worker's and its one-shot model.
  const changed = { ...form, model: "claude-opus-5-5" };
  assert.deepEqual([amuxWorkerCapabilityFromForm(recorded, changed).model, amuxWorkerCapabilityFromForm(recorded, changed).v22.model],
    ["claude-opus-5-5", "claude-opus-5-5"]);
  assert.equal(amuxWorkerCapabilityFormChanges(recorded, changed), true);
});

test("a record that is no preset is custom, and the form starts from the ceiling's preset", () => {
  const custom = row({ current: { revision: 2, changedAt: "2026-10-18T00:00:00.000Z", capability: {
    model: "claude-opus-5-5", routingTags: ["chore", "tests"], toolCapabilities: ["git", "shell"],
    v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] },
  } } });
  assert.equal(amuxWorkerCapabilityIsCustom(custom), true);
  const form = amuxWorkerCapabilityFormFromRow(custom);
  assert.deepEqual([form.preset, form.model, form.oneShot, form.expectedRevision], ["impl", "claude-opus-5-5", true, 2]);
  // Saving rewrites it as that preset.
  assert.equal(amuxWorkerCapabilityFormChanges(custom, form), true);
  // Nothing recorded is not custom; the form is empty against revision 0.
  assert.equal(amuxWorkerCapabilityIsCustom(row()), false);
  assert.deepEqual(amuxWorkerCapabilityFormFromRow(row()), { workerName: "claude-impl", expectedRevision: 0, preset: "impl", model: "", oneShot: false });
});

test("the refusal preview is the store's rule for this worker's class and ceiling", () => {
  const base = amuxWorkerCapabilityFormFromRow(row());
  for (const [form, expected] of [
    [{ ...base, model: "claude-sonnet-5" }, null],
    [{ ...base, model: "claude-sonnet-5", oneShot: true }, null],
    // A Claude worker stays on a claude-* model when it takes Tasks.
    [{ ...base, model: "gpt-6-luna", oneShot: true }, "v22_model_unsupported"],
    [{ ...base, model: "", oneShot: true }, "v22_model_unsupported"],
  ]) {
    assert.equal(amuxWorkerCapabilityFormRefusal(row(), form), expected, JSON.stringify(form));
    assert.equal(amuxWorkerCapabilityFormRefusal(row(), form),
      amuxWorkerCapabilityRefusal(registrationOf(row()), amuxWorkerCapabilityFromForm(row(), form)));
  }
  // A preset the worker cannot hold is named before the store's rule.
  assert.equal(amuxWorkerCapabilityFormRefusal(row(), { ...base, preset: "contract" }), "preset_unavailable");
  assert.equal(amuxWorkerCapabilityFormRefusal(row({ desiredState: "retired" }), { ...base, model: "m" }), "retired");
});
