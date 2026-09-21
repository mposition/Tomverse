import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// The `AppSetting` row the suppression read authority used to live in is kept
// on purpose, and this is the thing that keeps it.
//
// Contract: docs/policy/email-notifications.md v28.
//
// Deploy D-1 removed every reader of the setting from this build, and v27 said
// a following deploy would delete the row. v28 reversed that while the stored
// value is `causes`: a build older than D-1 reads the row, and with it present
// reads `causes` and behaves correctly. Delete it and that build reads an
// absent row as `entry`.
//
// The failure this guards is specific and is not about today's tree. Nothing
// here reads the row and nothing deletes it. The risk is that somebody who
// remembers the original plan writes the D-2 migration, and it reaches
// production in the same release as D-1. Migrations run **before** the new
// build serves, so at that moment the serving build is the one on `main` -- a
// B-era build, which answers an absent row by sending from `SuppressionEntry`,
// a table frozen since deploy C. That is mail to people who asked us to stop,
// and it is the one outcome in this series that cannot be undone.
//
// So: no active migration may mention the key. When the two conditions in v28
// item 3 are actually met -- production running a build with no reader, and the
// release's own `Rollback SHA` likewise -- deleting this test is the first step
// of D-2, and deleting it is what says the conditions were checked.

const repositoryRoot = resolve(import.meta.dirname, "..");
const migrationsRoot = join(repositoryRoot, "prisma", "migrations");

const RETIRED_AUTHORITY_KEY = "email.suppressionReadAuthority";

/** Every applied migration's SQL, by the directory that names it. */
const migrationSql = () =>
  readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(migrationsRoot, entry.name, "migration.sql"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => ({
      name: path.slice(migrationsRoot.length + 1).replaceAll("\\", "/"),
      sql: readFileSync(path, "utf8"),
    }));

test("the migrations are read at all", () => {
  // A guard that silently matched nothing would pass forever. If the directory
  // moves, this fails rather than the assertion below quietly becoming vacuous.
  const migrations = migrationSql();
  assert.ok(migrations.length > 50, `only ${migrations.length} migrations found`);
  assert.ok(
    migrations.some((migration) => migration.sql.includes("SuppressionCause")),
    "the suppression migrations are not among the files being read"
  );
});

test("no migration touches the retired suppression read authority row", () => {
  const offenders = migrationSql()
    .filter((migration) => migration.sql.includes(RETIRED_AUTHORITY_KEY))
    .map((migration) => migration.name);

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} names ${RETIRED_AUTHORITY_KEY}. ` +
      "That row is kept deliberately while a build older than D-1 could serve: " +
      "such a build reads an absent row as `entry` and sends from a table frozen " +
      "since deploy C. See docs/policy/email-notifications.md v28 for the two " +
      "conditions that release it, and delete this test as the first step of D-2 " +
      "once they hold."
  );
});
