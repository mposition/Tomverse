// The migration and the module that defines what it enforces.
//
// Every list and limit the SQL writes out also exists in
// lib/productResearchObservationCore.mjs, which is where the application reads
// it. This reads both and fails when they differ, so neither can be edited
// alone -- a stage added to the module and not to the CHECK is a submission the
// application accepts and the database refuses, and the reverse is a stage
// that can be stored and has no label.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  OBSERVATION_FAILURE_STAGES,
  OBSERVATION_RETENTION_DAYS,
  OBSERVATION_ROW_LIMIT,
  OBSERVATION_SCHEMA_VERSION,
} from "../lib/productResearchObservationCore.mjs";
import { SLOT_WINDOW_MS } from "../lib/productResearchObservationRunnerCore.mjs";

const sql = readFileSync(
  new URL(
    "../prisma/migrations/20261002150000_product_research_observation/migration.sql",
    import.meta.url
  ),
  "utf8"
).replace(/\r\n/g, "\n");

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);

/** The quoted values of the CHECK following a `-- <kind>: <NAME>` marker. */
const markedBlock = (marker) => {
  const index = sql.indexOf(marker);
  assert.notEqual(index, -1, `the migration has no ${marker} marker`);
  // Up to the end of that ALTER TABLE clause.
  const rest = sql.slice(index + marker.length);
  const end = rest.indexOf("),\n");
  return rest.slice(0, end === -1 ? rest.indexOf(";") : end);
};

test("the failure stages in the CHECK are exactly the module's", () => {
  const block = markedBlock("-- stages: OBSERVATION_FAILURE_STAGES");
  const quoted = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...quoted].sort(), [...OBSERVATION_FAILURE_STAGES].sort());
  // Order matters nowhere, but a duplicate in either list means one of them was
  // edited by hand into something a set comparison would have hidden.
  assert.equal(new Set(quoted).size, quoted.length);
  assert.equal(
    new Set(OBSERVATION_FAILURE_STAGES).size,
    OBSERVATION_FAILURE_STAGES.length
  );
});

test("the schema version, row limit, retention and window are the module's numbers", () => {
  assert.match(
    markedBlock("-- version: OBSERVATION_SCHEMA_VERSION"),
    new RegExp(`"schemaVersion" = ${OBSERVATION_SCHEMA_VERSION}\\b`)
  );
  assert.match(
    markedBlock("-- limit: OBSERVATION_ROW_LIMIT"),
    new RegExp(`<= ${OBSERVATION_ROW_LIMIT}\\b`)
  );
  assert.match(
    sql,
    new RegExp(
      `-- retention: OBSERVATION_RETENTION_DAYS\\n\\s*retention CONSTANT INTERVAL := INTERVAL '${OBSERVATION_RETENTION_DAYS} days';`
    )
  );
  // The window the trigger enforces is the one the runner decides its own slot
  // membership with. An hour here and two there means a run that believes it is
  // inside its window and whose row is refused -- a silent miss.
  assert.equal(SLOT_WINDOW_MS, 60 * 60 * 1000);
  assert.match(
    sql,
    /-- window: SLOT_WINDOW_MS\n\s*slot_window CONSTANT INTERVAL := INTERVAL '1 hour';/
  );
});

test("the table is insert-only, kept for its retention, and one row per slot", () => {
  // The three things the application cannot be the only holder of.
  assert.match(sql, /ADD CONSTRAINT "ProductResearchObservation_slot_key" UNIQUE \("slot"\)/);
  assert.match(sql, /'ProductResearchObservation is insert-only'/);
  assert.match(sql, /'ProductResearchObservation is kept for its retention period'/);
  assert.match(sql, /'ProductResearchObservation slot window has passed'/);
  assert.match(sql, /'ProductResearchObservation slot has not started'/);

  // submittedAt is the database's. A submitter that could set it could place a
  // row inside a window it missed, and could put a row out of the sweep's
  // reach.
  assert.match(sql, /NEW\."submittedAt" := now_utc;/);

  assert.match(
    sql,
    /BEFORE INSERT OR UPDATE OR DELETE ON "ProductResearchObservation"\n\s*FOR EACH ROW EXECUTE FUNCTION "product_research_observation_guard"\(\)/
  );
  // The function reads nothing else, so pinning search_path is enough; a
  // function that looked up a sibling table would also need TG_TABLE_SCHEMA.
  assert.match(sql, /SET search_path = pg_catalog, pg_temp/);
  assert.match(sql, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
});

/**
 * The shape check as the database ends up with it.
 *
 * Read from the **last** migration that defines it rather than from the one
 * that defined it first: a later migration can redefine a constraint, and a
 * test pinned to the original file would keep asserting a definition the
 * database no longer has. That is what happened here -- the first definition
 * left `developSha` and `mainSha` open on the failed branch.
 */
const effectiveShapeCheck = () => {
  const root = new URL("../prisma/migrations/", import.meta.url);
  const marker = 'ADD CONSTRAINT "ProductResearchObservation_outcome_shape_check"';
  // Directories, not "everything that is not the lock file": a README added
  // here later would otherwise be opened as a migration and throw.
  const defining = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      body: readFileSync(new URL(`${name}/migration.sql`, root), "utf8").replace(/\r\n/g, "\n"),
    }))
    .filter(({ body }) => body.includes(marker));
  assert.ok(defining.length > 0, "no migration defines the shape check");
  const last = defining[defining.length - 1];
  return last.body.slice(last.body.lastIndexOf(marker));
};

test("a failed slot has nowhere to put a success's content", () => {
  const shape = effectiveShapeCheck();
  for (const required of [
    '"outcome" = \'failed\'',
    '"failureStage" IS NOT NULL',
    // The two the first definition forgot. A failed row holding the commits of
    // a successful observation is exactly the "a failure showing an earlier
    // success’s content" this constraint exists to prevent, through the only
    // two columns it left open.
    '"developSha" IS NULL',
    '"mainSha" IS NULL',
    '"issueCount" IS NULL',
    '"payload" IS NULL',
    '"payloadDigest" IS NULL',
  ]) {
    assert.ok(shape.includes(required), `the shape check is missing ${required}`);
  }
});

test("the Prisma model matches the columns the migration creates", () => {
  const model = schema.slice(schema.indexOf("model ProductResearchObservation {"));
  const body = model.slice(0, model.indexOf("\n}\n") + 1);
  assert.notEqual(body.length, 0);

  const columns = [...sql.matchAll(/^ {4}"([A-Za-z]+)" (TEXT|INTEGER|JSONB|TIMESTAMP\(3\))/gm)].map(
    (match) => match[1]
  );
  assert.ok(columns.length > 0);
  for (const column of columns) {
    assert.match(body, new RegExp(`^\\s*${column}\\s`, "m"), `the model has no ${column}`);
  }
  // And nothing extra: a field Prisma knows and the table does not is a write
  // that fails at runtime with a column name the application chose.
  const fields = [...body.matchAll(/^\s{2}([a-zA-Z]+)\s+\S/gm)].map((match) => match[1]);
  assert.deepEqual([...fields].sort(), [...columns].sort());
});
