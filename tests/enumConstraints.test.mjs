import assert from "node:assert/strict";
import test from "node:test";

import {
  auditEnumConstraints,
  readEnumConstraints,
} from "../scripts/check-enum-constraints-core.mjs";

// Reading the effective closed list out of an append-only migration history,
// and comparing it against the one the application validates with.
//
// The parsing is the part worth testing directly: a constraint is changed by
// dropping it and adding it again, so "what does the database enforce today"
// is a fold over every migration rather than a grep of the newest one.

const migration = (name, sql) => ({ name, sql });

test("the newest definition of a constraint wins", () => {
  const constraints = readEnumConstraints([
    migration(
      "0001_initial",
      `ALTER TABLE "Thing" ADD CONSTRAINT "Thing_state_check"
         CHECK ("state" IN ('a', 'b'));`
    ),
    migration(
      "0002_add_c",
      `ALTER TABLE "Thing" DROP CONSTRAINT "Thing_state_check";
       ALTER TABLE "Thing" ADD CONSTRAINT "Thing_state_check"
         CHECK ("state" IN ('a', 'b', 'c'));`
    ),
  ]);

  assert.equal(constraints.length, 1);
  assert.deepEqual(constraints[0].values, ["a", "b", "c"]);
  assert.equal(constraints[0].migration, "0002_add_c");
});

test("a constraint that was dropped and not re-added is gone", () => {
  const constraints = readEnumConstraints([
    migration(
      "0001",
      `ALTER TABLE "Thing" ADD CONSTRAINT "Thing_state_check"
         CHECK ("state" IN ('a', 'b'));`
    ),
    migration("0002", `ALTER TABLE "Thing" DROP CONSTRAINT "Thing_state_check";`),
  ]);
  assert.deepEqual(constraints, []);
});

// The bug this parser had on its first run: without the statement terminator,
// the span between ALTER TABLE and ADD CONSTRAINT ran into the next statement
// and attributed User_plan_check to whichever table was altered above it.
test("a constraint is attributed to its own ALTER TABLE, not the one above it", () => {
  const constraints = readEnumConstraints([
    migration(
      "0001",
      `ALTER TABLE "Other"
         ADD COLUMN "note" TEXT;

       ALTER TABLE "Thing"
         ADD CONSTRAINT "Thing_state_check"
         CHECK ("state" IN ('a', 'b'));`
    ),
  ]);
  assert.equal(constraints[0].table, "Thing");
});

test("an inline CREATE TABLE constraint is read, and a later ALTER overrides it", () => {
  const constraints = readEnumConstraints([
    migration(
      "0001",
      `CREATE TABLE "Thing" (
         "state" TEXT NOT NULL,
         CONSTRAINT "Thing_state_check" CHECK ("state" IN ('a'))
       );`
    ),
    migration(
      "0002",
      `ALTER TABLE "Thing" DROP CONSTRAINT "Thing_state_check";
       ALTER TABLE "Thing" ADD CONSTRAINT "Thing_state_check"
         CHECK ("state" IN ('a', 'b'));`
    ),
  ]);
  assert.deepEqual(constraints[0].values, ["a", "b"]);
});

// Range checks are not closed lists and are none of this check's business.
test("a non-enum CHECK is ignored", () => {
  const constraints = readEnumConstraints([
    migration(
      "0001",
      `ALTER TABLE "Thing" ADD CONSTRAINT "Thing_count_nonnegative"
         CHECK ("count" >= 0);`
    ),
  ]);
  assert.deepEqual(constraints, []);
});

const constraint = (values) => [
  { constraint: "Thing_state_check", table: "Thing", column: "state", values, migration: "0001" },
];
const listEntry = {
  owner: "list",
  module: "lib/thing.ts",
  list: "THING_STATES",
  reason: "the states",
};

test("a value code accepts and the database rejects is reported as such", () => {
  const problems = auditEnumConstraints({
    constraints: constraint(["a", "b"]),
    registry: { Thing_state_check: listEntry },
    resolve: () => ["a", "b", "c"],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "mismatch");
  assert.match(problems[0].message, /code accepts, database rejects[^\n]*c/);
});

test("a value only the database accepts is reported as dead configuration", () => {
  const problems = auditEnumConstraints({
    constraints: constraint(["a", "b", "c"]),
    registry: { Thing_state_check: listEntry },
    resolve: () => ["a", "b"],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /dead configuration[^\n]*c/);
});

test("agreement in a different order is agreement", () => {
  assert.deepEqual(
    auditEnumConstraints({
      constraints: constraint(["b", "a"]),
      registry: { Thing_state_check: listEntry },
      resolve: () => ["a", "b"],
    }),
    []
  );
});

// The case the check exists for: a closed list arrives in the schema and
// nothing records whether the application knows about it.
test("an unregistered constraint fails", () => {
  const problems = auditEnumConstraints({
    constraints: constraint(["a", "b"]),
    registry: {},
    resolve: () => null,
  });
  assert.equal(problems[0].kind, "unregistered");
});

test("a registry entry for a constraint that no longer exists fails", () => {
  const problems = auditEnumConstraints({
    constraints: [],
    registry: { Thing_state_check: listEntry },
    resolve: () => ["a"],
  });
  assert.equal(problems[0].kind, "stale_entry");
});

test("an entry without a reason fails, whatever its owner", () => {
  for (const owner of ["list", "type_only", "database"]) {
    const problems = auditEnumConstraints({
      constraints: constraint(["a"]),
      registry: { Thing_state_check: { owner, module: "lib/thing.ts", list: "X", reason: " " } },
      resolve: () => ["a"],
    });
    assert.ok(
      problems.some((problem) => problem.kind === "no_reason"),
      `${owner} was allowed through without a reason`
    );
  }
});

// type_only and database entries record a decision rather than a comparison.
// They must not silently become "checked".
test("entries with no application list are recorded, not compared", () => {
  assert.deepEqual(
    auditEnumConstraints({
      constraints: constraint(["a", "b"]),
      registry: {
        Thing_state_check: { owner: "database", reason: "only the schema says so" },
      },
      resolve: () => {
        throw new Error("a database-owned entry must not be resolved");
      },
    }),
    []
  );
});
