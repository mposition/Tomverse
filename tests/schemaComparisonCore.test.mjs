import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareSchemaSection,
  compareSchemas,
  redactConnectionStrings,
} from "../lib/schemaComparisonCore.mjs";

const map = (entries) => new Map(entries);

test("identical sections report no difference", () => {
  const rows = map([
    ["User.id", "text null=NO default=-"],
    ["User.email", "text null=YES default=-"],
  ]);
  const result = compareSchemaSection("columns", rows, map([...rows]));
  assert.equal(result.differenceCount, 0);
  assert.equal(result.identicalCount, 2);
  assert.deepEqual(result.definitionMismatch, []);
});

test("an object the migrations do not create is only_in_source", () => {
  const result = compareSchemaSection(
    "indexes",
    map([["Foo.Foo_hand_applied_idx", "CREATE INDEX ..."]]),
    map([])
  );
  assert.deepEqual(result.onlyInSource, [
    "Foo.Foo_hand_applied_idx :: CREATE INDEX ...",
  ]);
  assert.deepEqual(result.onlyInDatabase, []);
  assert.deepEqual(result.definitionMismatch, []);
});

test("an object the source is missing is only_in_database", () => {
  const result = compareSchemaSection(
    "constraints",
    map([]),
    map([["Foo.Foo_check", "CHECK ((x > 0))"]])
  );
  assert.deepEqual(result.onlyInDatabase, ["Foo.Foo_check :: CHECK ((x > 0))"]);
  assert.deepEqual(result.onlyInSource, []);
});

test("a partial index that kept its name and lost its predicate is a definition_mismatch", () => {
  // The incident this tool exists for. As two sets of opaque strings this
  // reads as "one index removed, one added", which buries the only fact that
  // matters: the name still resolves and now means something weaker.
  const name = "PlanChangeRequest.PlanChangeRequest_userId_active_key";
  const withPredicate =
    'CREATE UNIQUE INDEX "PlanChangeRequest_userId_active_key" ON public."PlanChangeRequest" USING btree ("userId") WHERE (status = \'pending\'::text)';
  const withoutPredicate =
    'CREATE UNIQUE INDEX "PlanChangeRequest_userId_active_key" ON public."PlanChangeRequest" USING btree ("userId")';

  const result = compareSchemaSection(
    "indexes",
    map([[name, withoutPredicate]]),
    map([[name, withPredicate]])
  );

  assert.deepEqual(result.onlyInSource, []);
  assert.deepEqual(result.onlyInDatabase, []);
  assert.equal(result.definitionMismatch.length, 1);
  assert.equal(result.definitionMismatch[0].key, name);
  assert.equal(result.definitionMismatch[0].source, withoutPredicate);
  assert.equal(result.definitionMismatch[0].database, withPredicate);
  assert.equal(result.differenceCount, 1);
});

test("a changed CHECK constraint is a definition_mismatch, not an add and a drop", () => {
  const result = compareSchemaSection(
    "constraints",
    map([["ProductAnalyticsEvent.pae_name_check", "CHECK ((name = ANY (ARRAY['a'])))"]]),
    map([
      [
        "ProductAnalyticsEvent.pae_name_check",
        "CHECK ((name = ANY (ARRAY['a', 'b'])))",
      ],
    ])
  );
  assert.equal(result.definitionMismatch.length, 1);
  assert.equal(result.onlyInSource.length, 0);
  assert.equal(result.onlyInDatabase.length, 0);
});

test("a column's type, nullability and default are each compared", () => {
  for (const [sourceDefinition, migrationsDefinition] of [
    ["integer null=NO default=-", "bigint null=NO default=-"],
    ["text null=YES default=-", "text null=NO default=-"],
    [
      "text null=NO default='gpt-5-4-mini'::text",
      "text null=NO default='gpt-5-6-luna'::text",
    ],
  ]) {
    const result = compareSchemaSection(
      "columns",
      map([["UserSettings.defaultModel", sourceDefinition]]),
      map([["UserSettings.defaultModel", migrationsDefinition]])
    );
    assert.equal(
      result.definitionMismatch.length,
      1,
      `${sourceDefinition} vs ${migrationsDefinition}`
    );
  }
});

test("totals are reported per classification across every section", () => {
  const { totals, differenceCount, comparisons } = compareSchemas(
    {
      columns: map([["A.a", "text"], ["A.b", "text"]]),
      indexes: map([["A.only_here", "CREATE INDEX ..."]]),
      constraints: map([["A.c", "CHECK ((x > 0))"]]),
    },
    {
      columns: map([["A.a", "text"], ["A.b", "integer"]]),
      indexes: map([]),
      constraints: map([
        ["A.c", "CHECK ((x > 0))"],
        ["A.d", "CHECK ((y > 0))"],
      ]),
    },
    ["columns", "indexes", "constraints"]
  );

  assert.deepEqual(totals, {
    only_in_source: 1,
    only_in_database: 1,
    definition_mismatch: 1,
  });
  assert.equal(differenceCount, 3);
  assert.equal(comparisons.length, 3);
  assert.equal(comparisons[0].identicalCount, 1);
});

test("a missing section is treated as empty rather than throwing", () => {
  const { totals } = compareSchemas(
    { columns: map([["A.a", "text"]]) },
    {},
    ["columns", "enums"]
  );
  assert.equal(totals.only_in_source, 1);
});

test("connection strings never survive into printed output", () => {
  const message =
    'connect ECONNREFUSED for postgresql://user:hunter2@db.internal:5432/tomverse?sslmode=require and postgres://a:b@h/d';
  const redacted = redactConnectionStrings(message);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("db.internal"), false);
  assert.equal(redacted.includes("://"), false);
  assert.match(redacted, /\[redacted-connection-string\]/);
});

test("the compare script prints nothing that has not been redacted", () => {
  const source = readFileSync(
    join(process.cwd(), "scripts/compare-schema-to-migrations.mjs"),
    "utf8"
  );
  // The evidence header names the databases and server versions, never a URL.
  assert.equal(/console\.(log|error|warn)\([^)]*sourceUrl/.test(source), false);
  assert.equal(/console\.(log|error|warn)\([^)]*scratchUrl/.test(source), false);
  assert.match(source, /redactConnectionStrings/);

  // Read-only against the source: every statement it sends there is a SELECT.
  const queryBlock = source.slice(
    source.indexOf("const QUERIES"),
    source.indexOf("const readSchema")
  );
  for (const forbidden of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE"]) {
    assert.equal(
      queryBlock.toUpperCase().includes(forbidden),
      false,
      `the source database must only ever be read (found ${forbidden})`
    );
  }
});
