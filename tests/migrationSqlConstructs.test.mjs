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
 * stays even and the guard stays quiet.
 *
 * ## What this claims, and what it does not
 *
 * It reports a dollar **standing alone as a token**: nothing but whitespace or
 * punctuation on either side of it. That is exactly the shape of the mistake --
 * `DO $` and `END $;` -- and nothing else in Postgres is written that way.
 *
 * The tempting rule, "every dollar outside a tag is a mistake", is false, and
 * the first attempt at this used it. Postgres allows a dollar in a positional
 * parameter (`$1`), inside an unquoted identifier after its first character
 * (`foo$bar`, and `foo$$` where the pair is part of the name), anywhere inside
 * a quoted one (`"a $ b"`), and inside a string literal. Standing alone
 * excludes the first two by what is beside them; the last two need this to know
 * where a quoted region begins and ends, which is what the scan below does.
 *
 * Three regions are skipped whole, and the order they are recognised in is the
 * point: a dollar-quoted body first, because inside one an apostrophe is an
 * ordinary character and treating it as a quote would swallow the closing tag
 * (`$$ it's fine $$`); then `'...'`, where a doubled quote escapes and a
 * backslash does so only in an `E'...'` string; then `"..."`, where a doubled
 * quote escapes and nothing else does.
 *
 * A tag also has to be separated from what precedes it, so `foo$$` is an
 * identifier rather than an opening tag.
 *
 * What it does not catch, stated rather than implied: `DO $1$ BEGIN END $1$;`
 * is invalid -- a tag cannot begin with a digit -- and passes, because every
 * dollar in it touches a character. `DO$$ ... $$;` is invalid for the other
 * reason and *is* reported, though as a block that never closes rather than as
 * an attached tag. Catching the first properly means lexing Postgres, and this
 * is a guard for one regression, not a lexer.
 *
 * Returns each stray dollar's offset, and the end of the file when a block was
 * opened and never closed.
 */
const strayDollars = (sql) => {
  const openingTag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
  const alone = /[\s;,()[\]]|^$/;
  // An unquoted identifier may hold any letter or digit, not only ASCII ones,
  // so an ASCII-only class would read a dollar pair after a non-ASCII name as an
  // opening tag -- and then skip to the next pair, hiding whatever is between
  // them.
  const identifierCharacter = /[\p{L}\p{N}_$]/u;
  const stray = [];
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];

    if (current === "$") {
      const attached = identifierCharacter.test(sql[index - 1] ?? "");
      const tag = attached ? null : openingTag.exec(sql.slice(index));
      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        if (close < 0) {
          // Opened and never closed: everything after it is body, and the file
          // does not parse.
          stray.push(sql.length);
          break;
        }
        index = close + tag[0].length;
        continue;
      }
      if (alone.test(sql[index - 1] ?? "") && alone.test(sql[index + 1] ?? "")) {
        stray.push(index);
      }
      index += 1;
      continue;
    }

    if (current === "'" || current === '"') {
      // A backslash escapes only in an E-string, and only for the single-quoted
      // kind. `standard_conforming_strings` has been on by default since 9.1,
      // so a plain '...' takes backslashes literally.
      const escapes =
        current === "'" &&
        /[Ee]/.test(sql[index - 1] ?? "") &&
        !identifierCharacter.test(sql[index - 2] ?? "");
      index += 1;
      while (index < sql.length) {
        if (escapes && sql[index] === "\\") {
          index += 2;
          continue;
        }
        if (sql[index] === current) {
          // A doubled quote is one quote of content, not the end.
          if (sql[index + 1] === current) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    index += 1;
  }
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

  // The legitimate dollars that are not tags, which the rule "every dollar
  // belongs to a tag" rejected when this was first written.
  assert.deepEqual(
    strayDollars("PREPARE q(text) AS SELECT * FROM t WHERE value = $1;"),
    []
  );
  assert.deepEqual(strayDollars(`CREATE TABLE foo$bar (id integer);`), []);
  assert.deepEqual(strayDollars(`CREATE TABLE "foo$bar" (id integer);`), []);
  assert.deepEqual(strayDollars(`SELECT "$foo";`), []);
  assert.deepEqual(strayDollars(`SELECT E'it\\'s $x';`), []);
  // A trailing pair is part of the identifier, not an opening tag -- which is
  // why a tag has to be separated from what precedes it.
  assert.deepEqual(strayDollars(`SELECT foo${doubled};`), []);
  // A lone dollar inside a quoted identifier is a character in a name.
  assert.deepEqual(strayDollars(`SELECT "a $ b";`), []);
  // A doubled quote is content, so this string does not end early and take the
  // rest of the file with it.
  assert.deepEqual(strayDollars(`SELECT 'it''s $x' AS value;`), []);

  // An escaped quote inside an E-string does not end it, so the mistake after
  // it is still found rather than swallowed as string content.
  assert.equal(strayDollars(`SELECT E'it\\'s'; DO $ BEGIN END $;`).length, 2);

  // `DO$$` is not an opening tag -- a tag has to be separated from what
  // precedes it -- so the pair that closes the block opens one instead, and the
  // file is reported as ending inside it. Invalid SQL, reported for the wrong
  // reason, which beats not reported.
  assert.equal(strayDollars(`DO${doubled} BEGIN END ${doubled};`).length, 1);

  // And what it does not catch, asserted so the limit is a decision rather than
  // a surprise: a tag cannot begin with a digit, so this is invalid SQL, and
  // every dollar in it touches a character.
  assert.deepEqual(strayDollars("DO $1$ BEGIN END $1$;"), []);
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
