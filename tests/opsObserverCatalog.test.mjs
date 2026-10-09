// T3a of the ops-observer trust check: the catalogue matches the expected
// triggers (enabled, running their own functions), constraints and indexes of
// the own tables exactly; only the listed deadline checks are deferred; the
// shared tables were read and carry nothing deferrable. The expected sets are
// also checked against the migration text itself, so they cannot drift from
// what the migrations create.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  EXPECTED_CONSTRAINTS,
  EXPECTED_INDEXES,
  EXPECTED_TRIGGERS,
  EXPECTED_TRIGGER_FUNCTIONS,
  OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS,
  OPS_OBSERVER_OWN_TABLES,
  catalogProblems,
} from "../scripts/ops-observer/catalog-core.mjs";

// Every ops-observer migration, found rather than listed, so a new one cannot
// add a catalogue object this check never reads.
const MIGRATION_DIRS = readdirSync(new URL("../prisma/migrations/", import.meta.url)).filter((name) =>
  /_ops_observer_/.test(name),
);
const MIGRATIONS = MIGRATION_DIRS.map((name) =>
  readFileSync(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8"),
);

function soundCatalogue() {
  const isDeferred = (name) => OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS.includes(name);
  const triggers = Object.entries(EXPECTED_TRIGGERS).flatMap(([table, names]) =>
    names.map((name) => ({
      table,
      tableSchema: "public",
      name,
      enabled: "O",
      functionSchema: "public",
      functionName: EXPECTED_TRIGGER_FUNCTIONS[name],
      deferrable: isDeferred(name),
      initiallyDeferred: isDeferred(name),
    })),
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
  triggers.push({ table: "AdminAuditLog", name: "some_other_feature_guard", enabled: "O", functionName: "x", deferrable: false, initiallyDeferred: false });
  constraints.push({ table: "AdminAuditLog", name: "AdminAuditLog_pkey", type: "p", deferrable: false, initiallyDeferred: false });
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

test("a missing, extra, disabled, redirected or altered rule is a problem", () => {
  const trigger = (c, name) => c.triggers.find((r) => r.name === name);
  const cases = [
    (c) => c.triggers.splice(c.triggers.findIndex((r) => r.name === "OpsObserverTransition_no_truncate"), 1),
    (c) => c.triggers.push({ table: "OpsObserverState", name: "late_addition", enabled: "O", functionName: "x", deferrable: false, initiallyDeferred: false }),
    (c) => c.constraints.splice(c.constraints.findIndex((r) => r.name === "OpsObserverDelivery_lifecycle_check"), 1),
    (c) => (c.constraints.find((r) => r.name === "OpsObserverState_genesisId_fkey").type = "c"),
    (c) => c.indexes.splice(c.indexes.findIndex((r) => r.name === "OpsObserverDelivery_reservedMarker_key"), 1),
    (c) => c.indexes.push({ table: "OpsObserverTransition", name: "OpsObserverTransition_extra_idx" }),
    // The name survives but the guard does not fire, or runs something else.
    (c) => (trigger(c, "OpsObserverState_guard").enabled = "D"),
    (c) => (trigger(c, "OpsObserverState_guard").enabled = "R"),
    (c) => delete trigger(c, "OpsObserverState_guard").enabled,
    (c) => (trigger(c, "OpsObserverTransition_guard").functionName = "ops_observer_noop"),
    (c) => (trigger(c, "ops_observer_genesis_deadline_check").functionName = "ops_observer_noop"),
    (c) => (trigger(c, "OpsObserverTransition_guard").functionSchema = "elsewhere"),
    (c) => delete trigger(c, "OpsObserverTransition_guard").tableSchema,
    // A deadline check made immediate, or anything else made deferrable.
    (c) => (trigger(c, "ops_observer_state_deadline_check").initiallyDeferred = false),
    (c) => (c.constraints.find((r) => r.name === "ops_observer_genesis_deadline_check").deferrable = false),
    (c) => (c.constraints.find((r) => r.name === "OpsObserverTransition_genesisId_fkey").deferrable = true),
    (c) => (trigger(c, "OpsObserverDelivery_guard").initiallyDeferred = true),
    // Deferrable on a shared table, or a shared table never read.
    (c) => (c.triggers.find((r) => r.table === "AdminAuditLog").deferrable = true),
    (c) => c.constraints.push({ table: "AgentDigestItem", name: "x_fkey", type: "f", deferrable: true, initiallyDeferred: false }),
    (c) => (c.constraints = c.constraints.filter((r) => r.table !== "AdminAuditLog")),
    (c) => (c.constraints = c.constraints.filter((r) => r.table !== "AgentDigestItem")),
    // Rows that do not belong, or cannot be read.
    (c) => c.triggers.push({ table: "SomeOtherTable", name: "t", enabled: "O", functionName: "x", deferrable: false, initiallyDeferred: false }),
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

// The table a migration-named object belongs to: the longest own-table name
// that prefixes it, or for the lower-case deadline checks the table they are ON.
const ownerOf = (name) =>
  [...OPS_OBSERVER_OWN_TABLES].sort((a, b) => b.length - a.length).find((table) => name.startsWith(`${table}_`));

test("the expected sets are exactly what the migration text creates", () => {
  const sql = MIGRATIONS.join("\n");
  const triggers = {};
  const functions = {};
  for (const [statement, constraintKeyword, name, table, fn] of sql.matchAll(
    /CREATE (CONSTRAINT )?TRIGGER "?([A-Za-z_]+)"?\s+(?:BEFORE|AFTER)[^;]*?\bON "(\w+)"[^;]*?EXECUTE FUNCTION (\w+)\(\)/g,
  )) {
    (triggers[table] ??= []).push(name);
    functions[name] = fn;
    // A deadline check is a deferred constraint trigger in the text itself,
    // not just in the list this test is checking.
    const deferredInText = Boolean(constraintKeyword) && /DEFERRABLE INITIALLY DEFERRED/.test(statement);
    assert.equal(deferredInText, OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS.includes(name), name);
  }
  const constraints = {};
  for (const [, name] of sql.matchAll(/CONSTRAINT "(OpsObserver\w+)"/g)) {
    (constraints[ownerOf(name)] ??= []).push(name);
  }
  for (const name of Object.keys(functions)) {
    if (OPS_OBSERVER_DEFERRED_DEADLINE_TRIGGERS.includes(name)) {
      const table = Object.keys(triggers).find((t) => triggers[t].includes(name));
      (constraints[table] ??= []).push(name);
    }
  }
  const indexes = {};
  for (const [, name] of sql.matchAll(/CONSTRAINT "(OpsObserver\w+_(?:pkey|key))"/g)) (indexes[ownerOf(name)] ??= []).push(name);
  for (const [, name] of sql.matchAll(/CREATE INDEX "(OpsObserver\w+)"/g)) (indexes[ownerOf(name)] ??= []).push(name);

  const sorted = (byTable) =>
    Object.fromEntries(Object.entries(byTable).map(([table, names]) => [table, [...names].sort()]).sort());
  assert.deepEqual(sorted(triggers), sorted(EXPECTED_TRIGGERS));
  assert.deepEqual(functions, { ...EXPECTED_TRIGGER_FUNCTIONS });
  assert.deepEqual(sorted(constraints), sorted(Object.fromEntries(Object.entries(EXPECTED_CONSTRAINTS).map(([t, m]) => [t, Object.keys(m)]))));
  assert.deepEqual(sorted(indexes), sorted(EXPECTED_INDEXES));
});
