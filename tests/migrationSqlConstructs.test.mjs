import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * SQL constructs are not functions, so they cannot be schema-qualified.
 *
 * Migrations here are hardened by pinning `search_path` and writing
 * `pg_catalog.` in front of the functions they call, so a search_path a caller
 * controls cannot shadow one. That is right for functions. It is wrong for the
 * handful of things that *look* like functions and are parsed as expressions --
 * `COALESCE` and the rest below are SQL constructs, and `pg_catalog.coalesce(…)`
 * is a call to a function that does not exist.
 *
 * It fails at apply time with `42883`, which means the whole migration chain
 * stops: on 2026-09-18 eight of them in one migration took every DB integration
 * job on `develop` red, and the error named an unrelated migration from a year
 * earlier. Cheap to write, expensive to find.
 */

const MIGRATIONS = resolve(import.meta.dirname, "..", "prisma", "migrations");

/**
 * Construct names with no callable pg_catalog function of the same name.
 *
 * Not the whole list -- `CASE`, `IS DISTINCT FROM` and the rest are not written
 * in call form, so nobody can qualify them by accident. Some constructs such as
 * `SUBSTRING` also have callable catalog functions, so a blanket list of
 * function-like SQL syntax would reject valid hardened SQL.
 */
const NOT_FUNCTIONS = [
  "coalesce",
  "nullif",
  "greatest",
  "least",
  "trim",
  "cast",
];

/**
 * A fresh pattern each time.
 *
 * A shared global regex carries `lastIndex` between calls, so the second
 * `assert.match` against it silently starts halfway through the string and
 * reports a miss. The guard would then pass while matching nothing.
 */
const constructPattern = () =>
  new RegExp(`pg_catalog\\.(${NOT_FUNCTIONS.join("|")})\\s*\\(`, "gi");

/**
 * Hide SQL comments without moving the remaining text.
 *
 * Keeping every character position stable lets the failure below report a line
 * from the original migration. Quoted strings and identifiers are copied as-is
 * so comment markers in values do not hide executable SQL that follows them.
 */
const withoutSqlComments = (sql) => {
  const output = [...sql];
  let quote = null;
  let blockDepth = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];

    if (blockDepth > 0) {
      if (current === "/" && next === "*") {
        output[index] = output[index + 1] = " ";
        blockDepth += 1;
        index += 1;
      } else if (current === "*" && next === "/") {
        output[index] = output[index + 1] = " ";
        blockDepth -= 1;
        index += 1;
      } else if (current !== "\n" && current !== "\r") {
        output[index] = " ";
      }
      continue;
    }

    if (quote !== null) {
      if (current === quote && next === quote) {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }

    if (current === "'" || current === '"') {
      quote = current;
      continue;
    }

    if (current === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        output[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (current === "/" && next === "*") {
      output[index] = output[index + 1] = " ";
      blockDepth = 1;
      index += 1;
    }
  }

  return output.join("");
};

const migrationFiles = () =>
  readdirSync(MIGRATIONS)
    .filter((entry) => !entry.endsWith(".toml"))
    .map((directory) => ({
      path: `prisma/migrations/${directory}/migration.sql`,
      sql: (() => {
        try {
          return readFileSync(join(MIGRATIONS, directory, "migration.sql"), "utf8");
        } catch {
          return null;
        }
      })(),
    }))
    .filter((file) => file.sql !== null);

test("no migration qualifies a SQL construct as a catalog function", () => {
  const offenders = [];
  for (const file of migrationFiles()) {
    const executableSql = withoutSqlComments(file.sql);
    for (const match of executableSql.matchAll(constructPattern())) {
      const line = file.sql.slice(0, match.index).split("\n").length;
      offenders.push(`${file.path}:${line}  ${match[0].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these are SQL constructs, not functions in pg_catalog; the qualification " +
      "makes the migration fail to apply with 42883:\n" +
      offenders.join("\n")
  );
});

test("the guard finds what it is for", () => {
  // Written against the exact shape that broke the chain, so a future edit to
  // the pattern cannot quietly stop matching it.
  assert.match(
    `CHECK (pg_catalog.coalesce("dailyCapOverride", 0) >= 0)`,
    constructPattern()
  );
  assert.match(`pg_catalog.COALESCE (x, 0)`, constructPattern());
  assert.doesNotMatch(
    withoutSqlComments(
      `-- pg_catalog.coalesce(x, 0)\n/* pg_catalog.nullif(y, 0) */ SELECT 1;`
    ),
    constructPattern()
  );
  // And leaves the real catalog functions alone, which the same migrations are
  // full of and which the qualification is correct for.
  for (const legitimate of [
    `pg_catalog.clock_timestamp()`,
    `pg_catalog.jsonb_typeof(value)`,
    `pg_catalog.count(*)`,
    `pg_catalog.hashtext('key')`,
    // These names also have SQL-special forms, but unlike COALESCE they have
    // real pg_catalog functions that can be called with ordinary arguments.
    `pg_catalog.extract('epoch', value)`,
    `pg_catalog.overlay(value, replacement, 2, 3)`,
    `pg_catalog.position(needle, haystack)`,
    `pg_catalog.substring(value, 2, 3)`,
  ]) {
    assert.doesNotMatch(legitimate, constructPattern());
  }
});
