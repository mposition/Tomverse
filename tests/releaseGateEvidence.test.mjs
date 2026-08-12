import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "yaml";

import {
  classifyGate,
  GATE_EVIDENCE,
  GATE_VERDICTS,
  inventoryReleaseGates,
} from "../scripts/report-release-gate-evidence-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const registry = parse(
  readFileSync(join(root, "docs/release-gates/tomverse-chat-v1.yaml"), "utf8")
);

const has = (...paths) => {
  const set = new Set(paths);
  return (path) => set.has(path);
};

test("a gate whose capability is absent is backlog, not unmeasured", () => {
  const result = classifyGate(
    { id: "X-01" },
    {
      exists: () => false,
      mapping: { "X-01": { capability: ["lib/thing.ts"], measurement: [] } },
    }
  );
  assert.equal(result.verdict, GATE_VERDICTS.NOT_IMPLEMENTED);
  assert.deepEqual(result.missing, ["lib/thing.ts"]);
});

test("a gate with no measurement listed is built but unproven", () => {
  const result = classifyGate(
    { id: "X-01" },
    {
      exists: has("lib/thing.ts"),
      mapping: { "X-01": { capability: ["lib/thing.ts"], measurement: [] } },
    }
  );
  assert.equal(result.verdict, GATE_VERDICTS.IMPLEMENTED_UNMEASURED);
});

test("one missing measurement artefact is enough to stay unproven", () => {
  const result = classifyGate(
    { id: "X-01" },
    {
      exists: has("lib/thing.ts", "tests/one.test.mjs"),
      mapping: {
        "X-01": {
          capability: ["lib/thing.ts"],
          measurement: ["tests/one.test.mjs", "tests/two.test.mjs"],
        },
      },
    }
  );
  assert.equal(result.verdict, GATE_VERDICTS.IMPLEMENTED_UNMEASURED);
  assert.deepEqual(result.missing, ["tests/two.test.mjs"]);
});

test("every named artefact present is evidence_present, which is not passing", () => {
  const result = classifyGate(
    { id: "X-01" },
    {
      exists: has("lib/thing.ts", "tests/one.test.mjs"),
      mapping: {
        "X-01": {
          capability: ["lib/thing.ts"],
          measurement: ["tests/one.test.mjs"],
        },
      },
    }
  );
  assert.equal(result.verdict, GATE_VERDICTS.EVIDENCE_PRESENT);
  // The verdict names artefacts. Nothing here asserts a threshold was met, and
  // no vocabulary in the module says "passed" or "satisfied".
  assert.equal(Object.values(GATE_VERDICTS).includes("passing"), false);
  assert.equal(Object.values(GATE_VERDICTS).includes("satisfied"), false);
});

test("an unsupplied appliesWhen condition is undetermined, never excused", () => {
  const result = classifyGate(
    { id: "MEMORY-03", appliesWhen: "memory-release-b-enabled" },
    { exists: () => true, mapping: GATE_EVIDENCE }
  );
  assert.equal(result.verdict, GATE_VERDICTS.APPLICABILITY_UNKNOWN);
  assert.match(result.note, /runtime condition/);
});

test("a supplied condition that is off makes the gate not applicable", () => {
  const result = classifyGate(
    { id: "MEMORY-03", appliesWhen: "memory-release-b-enabled" },
    {
      exists: () => true,
      conditions: { "memory-release-b-enabled": false },
      mapping: GATE_EVIDENCE,
    }
  );
  assert.equal(result.verdict, GATE_VERDICTS.NOT_APPLICABLE);
});

test("a supplied condition that is on classifies the gate normally", () => {
  const result = classifyGate(
    { id: "MEMORY-04", appliesWhen: "memory-release-b-enabled" },
    {
      exists: (path) => existsSync(join(root, path)),
      conditions: { "memory-release-b-enabled": true },
      mapping: GATE_EVIDENCE,
    }
  );
  assert.notEqual(result.verdict, GATE_VERDICTS.NOT_APPLICABLE);
  assert.notEqual(result.verdict, GATE_VERDICTS.APPLICABILITY_UNKNOWN);
});

test("a gate with no mapping is reported as unmapped rather than guessed at", () => {
  const result = classifyGate(
    { id: "NEW-01" },
    { exists: () => true, mapping: {} }
  );
  assert.equal(result.verdict, GATE_VERDICTS.UNMAPPED);
});

test("every gate in the registry has an evidence mapping", () => {
  const unmapped = registry.gates
    .map((gate) => gate.id)
    .filter((id) => !(id in GATE_EVIDENCE));
  assert.deepEqual(
    unmapped,
    [],
    `${unmapped.length} gate(s) have no mapping: ${unmapped.join(", ")}`
  );
});

test("every mapping names a gate the registry actually has", () => {
  const ids = new Set(registry.gates.map((gate) => gate.id));
  const orphans = Object.keys(GATE_EVIDENCE).filter((id) => !ids.has(id));
  assert.deepEqual(orphans, [], `mapping names unknown gate(s): ${orphans.join(", ")}`);
});

test("every path a mapping claims is present really exists", () => {
  // The mapping is hand-written, so a renamed module would silently turn a
  // built gate into "nothing built yet". This pins the paths that are supposed
  // to resolve today; a path deliberately naming something unbuilt belongs in
  // the note, not in capability or measurement.
  const missing = [];
  for (const [id, entry] of Object.entries(GATE_EVIDENCE)) {
    for (const path of [...entry.capability, ...entry.measurement]) {
      if (!existsSync(join(root, path))) missing.push(`${id}: ${path}`);
    }
  }
  assert.deepEqual(missing, [], `mapped path(s) do not exist:\n  ${missing.join("\n  ")}`);
});

test("every mapping explains itself", () => {
  for (const [id, entry] of Object.entries(GATE_EVIDENCE)) {
    assert.equal(typeof entry.note, "string", `${id} has no note`);
    assert.ok(entry.note.length > 20, `${id}'s note says too little`);
  }
});

test("the inventory groups the real registry without throwing", () => {
  const report = inventoryReleaseGates({
    gates: registry.gates,
    exists: (path) => existsSync(join(root, path)),
  });
  assert.equal(report.classified.length, registry.gates.length);
  // The four memory gates carry appliesWhen and no condition was supplied.
  assert.equal(report.undetermined.length, 4);
  assert.equal(
    report.backlog.length + report.unproven.length + report.evidencePresent.length,
    registry.gates.length - 4
  );
});

test("the report never proposes a registry status", () => {
  const source = readFileSync(
    join(root, "scripts/report-release-gate-evidence-core.mjs"),
    "utf8"
  );
  // The registry's own allowed statuses must not appear as values this module
  // produces: approval is a human act recorded in the registry, and a report
  // that emitted "approved" would be a second approval path.
  for (const status of ["evidence-ready", "approved", "failed", "not-applicable"]) {
    assert.equal(
      source.includes(`"${status}"`),
      false,
      `the core module emits the registry status ${status}`
    );
  }
});

test("a gate met by an absence is judged on its check, not on a capability", () => {
  // PUSH-01 is met by push infrastructure *not* existing, so it has no
  // capability to point at and never will. Read the ordinary way, an empty
  // capability list means "nothing built yet" -- which parked it in the
  // work-candidate group permanently, and proposing work that is already done
  // is the exact failure this report exists to prevent.
  const mapping = {
    "X-01": {
      invertedScope: true,
      capability: [],
      measurement: ["scripts/check-thing.mjs"],
    },
  };
  assert.equal(
    classifyGate({ id: "X-01" }, { exists: has("scripts/check-thing.mjs"), mapping })
      .verdict,
    GATE_VERDICTS.EVIDENCE_PRESENT
  );
  // Without the check it is backlog again: the absence is asserted by the
  // check or by nothing.
  assert.equal(
    classifyGate({ id: "X-01" }, { exists: () => false, mapping }).verdict,
    GATE_VERDICTS.NOT_IMPLEMENTED
  );
  assert.equal(
    classifyGate(
      { id: "X-01" },
      { exists: () => true, mapping: { "X-01": { invertedScope: true, capability: [], measurement: [] } } }
    ).verdict,
    GATE_VERDICTS.NOT_IMPLEMENTED
  );
});

test("evidence_present still is not passing, inverted or not", () => {
  // Same caveat as every other gate: the artefacts the gate names exist. The
  // release bill of materials and the scope review are human artefacts and
  // are not in this tree.
  const result = classifyGate(
    { id: "PUSH-01" },
    { exists: () => true, mapping: GATE_EVIDENCE }
  );
  assert.equal(result.verdict, GATE_VERDICTS.EVIDENCE_PRESENT);
  assert.match(result.note, /scope review/);
});
