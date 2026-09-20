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

/**
 * A dollar quote opens and closes with a tag, and the tag needs both dollars.
 *
 * `DO $ ... END $;` is not a shortened `DO $` + `$`; it is a syntax error, and
 * Postgres reports it at apply time having parsed none of the rest of the file.
 * It is easy to write by accident, because a lone dollar survives almost
 * everything a doubled one does not: a shell expands the pair to a process id,
 * and more than one templating layer eats one of them. On 2026-09-20 a
 * verification block reached review having lost a dollar at each end for
 * exactly that reason.
 *
 * Counting tags does not find it -- a lone dollar is not a tag, so the count
 * stays even and the guard stays quiet. What finds it is looking for a dollar
 * that is not part of any tag.
 *
 * Which is not the same as "every dollar outside a tag is a mistake". Postgres
 * allows a dollar in three other places, and each is excluded by what sits
 * beside it rather than by parsing the statement:
 *
 *   - a positional parameter, `$1`, is a dollar followed by a digit;
 *   - an identifier may contain one after its first character, as in `foo$bar`
 *     or `"foo$bar"`, so a dollar preceded by an identifier character belongs
 *     to a name;
 *   - a dollar inside a single-quoted string, or inside a dollar-quoted body,
 *     is data and is skipped with the rest of it.
 *
 * The same rule read the other way closes a gap: a tag must be separated from
 * whatever precedes it, so `DO$body$` is not a dollar quote at all even though
 * it looks like one, and an opening tag preceded by an identifier character is
 * reported rather than believed.
 *
 * This is a guard, not a lexer. It does not know statements, only neighbours.
 *
 * Returns each stray dollar's offset, and the end of the file when a block was
 * opened and never closed.
 */
const strayDollars = (sql) => {
  const openingTag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
  const identifierCharacter = /[A-Za-z0-9_$]/;
  const stray = [];
  let index = 0;
  let inString = false;
  let openTag = null;

  while (index < sql.length) {
    if (openTag) {
      // Inside the body nothing is special except the closing tag -- not a
      // quote, and not a dollar.
      if (sql.startsWith(openTag, index)) {
        index += openTag.length;
        openTag = null;
        continue;
      }
      index += 1;
      continue;
    }
    const current = sql[index];
    if (inString) {
      if (current === "'") inString = false;
      index += 1;
      continue;
    }
    if (current === "'") {
      inString = true;
      index += 1;
      continue;
    }
    if (current === "$") {
      const previous = index > 0 ? sql[index - 1] : "";
      const attached = identifierCharacter.test(previous);
      const tag = openingTag.exec(sql.slice(index));
      if (tag && !attached) {
        openTag = tag[0];
        index += tag[0].length;
        continue;
      }
      // Part of a name, or a positional parameter. Neither is a tag and
      // neither is a mistake.
      if (!tag && (attached || /[0-9]/.test(sql[index + 1] ?? ""))) {
        index += 1;
        continue;
      }
      stray.push(index);
      index += 1;
      continue;
    }
    index += 1;
  }
  if (openTag) stray.push(sql.length);
  return stray;
};

test("no migration carries a dollar outside a dollar-quote tag", () => {
  const offenders = [];
  for (const file of migrationFiles()) {
    for (const offset of strayDollars(withoutSqlComments(file.sql))) {
      const line = file.sql.slice(0, offset).split("\n").length;
      offenders.push(`${file.path}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a dollar here belongs to no dollar-quote tag, which is what a tag that " +
      "lost one of its dollars looks like; the migration fails to parse:\n" +
      offenders.join("\n")
  );
});

test("the dollar-quote guard finds what it is for", () => {
  const doubled = "$" + "$";

  // The exact shape that got through review.
  assert.equal(strayDollars("DO $\nBEGIN\nEND $;").length, 2);
  // And the shapes that are right.
  assert.deepEqual(strayDollars(`DO ${doubled}\nBEGIN\nEND ${doubled};`), []);
  assert.deepEqual(strayDollars("DO $verify$\nBEGIN\nEND $verify$;"), []);
  // A dollar inside an ordinary string is not a tag and is not a mistake.
  assert.deepEqual(strayDollars("SELECT 'a$b' AS value;"), []);
  // Nor is one inside a dollar-quoted body, where quoting rules do not apply.
  assert.deepEqual(
    strayDollars(`DO ${doubled} RAISE EXCEPTION 'a$b'; ${doubled};`),
    []
  );
  // A block that is opened and never closed is reported too.
  assert.equal(strayDollars(`DO ${doubled} BEGIN END;`).length, 1);

  // The three legitimate dollars that are not tags, which a rule of "every
  // dollar belongs to a tag" would have rejected.
  assert.deepEqual(
    strayDollars("PREPARE q(text) AS SELECT * FROM t WHERE value = $1;"),
    []
  );
  assert.deepEqual(strayDollars(`CREATE TABLE foo$bar (id integer);`), []);
  assert.deepEqual(strayDollars(`CREATE TABLE "foo$bar" (id integer);`), []);

  // And the shape that looks like a tag and is not one: a dollar quote has to
  // be separated from what precedes it, so this is an identifier followed by a
  // syntax error rather than a block.
  assert.equal(strayDollars(`DO${doubled}\nBEGIN\nEND\n${doubled};`).length > 0, true);
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
