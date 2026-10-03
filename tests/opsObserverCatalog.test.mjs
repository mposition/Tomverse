// T3a of the ops-observer trust check: the catalogue matches the expected
// triggers, constraints and indexes of the own tables exactly; only the
// listed deadline checks are deferred; shared tables carry nothing deferrable.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  EXPECTED_TRIGGERS,
  OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS,
  catalogProblems,
} from "../scripts/ops-observer/catalog-core.mjs";

function soundCatalogue() {
  const isDeferred = (name) => OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS.includes(name);
  const triggers = Object.entries(EXPECTED_TRIGGERS).flatMap(([table, names]) =>
    names.map((name) => ({ table, name, deferrable: isDeferred(name), initiallyDeferred: isDeferred(name) })),
  );
  const constraints = Object.entries(EXPECTED_CONSTRAINTS).flatMap(([table, byName]) =>
    Object.entries(byName).map(([name, type]) => ({
      table,
      name,
      type,
      deferrable: isDeferred(name),
      initiallyDeferred: isDeferred(name),
    })),
  );
  const indexes = Object.entries(EXPECTED_INDEXES).flatMap(([table, names]) => names.map((name) => ({ table, name })));
  triggers.push({ table: "AdminAuditLog", name: "some_other_feature_guard", deferrable: false, initiallyDeferred: false });
  constraints.push({ table: "AgentDigestItem", name: "AgentDigestItem_pkey", type: "p", deferrable: false, initiallyDeferred: false });
  return { triggers, constraints, indexes };
}

const withEdit = (mutate) => {
  const catalogue = soundCatalogue();
  mutate(catalogue);
  return catalogProblems(catalogue);
};

test("the expected catalogue has no problems", () => {
  assert.deepEqual(catalogProblems(soundCatalogue()), []);
});

test("every deferred trigger is a deadline check on an own table", () => {
  const own = Object.values(EXPECTED_TRIGGERS).flat();
  for (const name of OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS) assert.ok(own.includes(name), name);
});

test("a missing, extra or altered rule is a problem", () => {
  const cases = [
    (c) => c.triggers.splice(c.triggers.findIndex((r) => r.name === "OpsObserverTransition_no_truncate"), 1),
    (c) => c.triggers.push({ table: "OpsObserverState", name: "late_addition", deferrable: false, initiallyDeferred: false }),
    (c) => c.constraints.splice(c.constraints.findIndex((r) => r.name === "OpsObserverDelivery_lifecycle_check"), 1),
    (c) => (c.constraints.find((r) => r.name === "OpsObserverState_genesisId_fkey").type = "c"),
    (c) => c.indexes.splice(c.indexes.findIndex((r) => r.name === "OpsObserverDelivery_reservedMarker_key"), 1),
    (c) => c.indexes.push({ table: "OpsObserverTransition", name: "OpsObserverTransition_extra_idx" }),
    // A deadline check made immediate, or anything else made deferrable.
    (c) => (c.triggers.find((r) => r.name === "ops_observer_state_deadline_check").initiallyDeferred = false),
    (c) => (c.constraints.find((r) => r.name === "ops_observer_genesis_deadline_check").deferrable = false),
    (c) => (c.constraints.find((r) => r.name === "OpsObserverTransition_auditLogId_fkey").deferrable = true),
    (c) => (c.triggers.find((r) => r.name === "OpsObserverDelivery_guard").initiallyDeferred = true),
    // Deferrable on a shared table.
    (c) => (c.triggers.find((r) => r.table === "AdminAuditLog").deferrable = true),
    (c) => c.constraints.push({ table: "AgentDigestItem", name: "x_fkey", type: "f", deferrable: true, initiallyDeferred: false }),
    // Rows that do not belong, or cannot be read.
    (c) => c.triggers.push({ table: "SomeOtherTable", name: "t", deferrable: false, initiallyDeferred: false }),
    (c) => c.indexes.push(null),
  ];
  for (const mutate of cases) {
    assert.notDeepEqual(withEdit(mutate), [], String(mutate));
  }
});

test("missing row lists fail closed", () => {
  assert.notDeepEqual(catalogProblems({ triggers: [], constraints: [] }), []);
  assert.notDeepEqual(catalogProblems({ triggers: [], constraints: [], indexes: [] }), []);
});
