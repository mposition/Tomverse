// Whether the closed lists the database enforces still match the ones the
// application validates against.
//
// Nineteen columns carry a `CHECK (... IN (...))` constraint. Each is a closed
// list, and for most of them the application holds its own copy: the validator
// that answers 400, the zod schema the route parses with, the union a
// TypeScript switch is exhaustive over. Nothing compared the two.
//
// The drift is asymmetric and both directions are bad:
//
//   * code accepts a value the constraint rejects -- the request passes
//     validation and then Postgres refuses the insert, so the user gets a 500
//     where they should have got a 400, and the failure surfaces at write time
//     rather than at review time;
//   * the constraint accepts a value code never emits -- dead configuration
//     that reads like a supported state.
//
// One of the nineteen already had a hand-written test
// (tests/productAnalyticsDatabaseConstraint.test.ts, named in the migration
// that recreates that constraint). It is left where it is; this covers the same
// column again, which costs nothing, and the other eighteen for the first time.
//
// Migrations are append-only and a constraint is changed by dropping and
// re-adding it, so the effective list is the last one in migration order --
// which is why this reads the whole history rather than the newest file.

/**
 * Every enum-shaped CHECK constraint in the schema, keyed by constraint name.
 *
 * `DROP CONSTRAINT` removes an entry, so a constraint that was dropped and not
 * re-added does not appear; a constraint that was recreated appears with its
 * newest values.
 */
export const readEnumConstraints = (migrations) => {
  const constraints = new Map();

  for (const { name: file, sql } of migrations) {
    for (const match of sql.matchAll(
      /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/gi
    )) {
      constraints.delete(match[1]);
    }

    // `[^;]*?` rather than `[\s\S]{0,300}?`: without the statement terminator
    // the span happily runs from one ALTER TABLE into the next statement's ADD
    // CONSTRAINT, which attributes a constraint to whichever table happened to
    // be altered above it. That misread User_plan_check as belonging to
    // ProviderCreditConfig.
    const addPattern =
      /ALTER\s+TABLE\s+(?:ONLY\s+)?"([^"]+)"[^;]*?ADD\s+CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(\s*"([^"]+)"\s+IN\s*\(([^;]*?)\)\s*\)/gi;
    for (const match of sql.matchAll(addPattern)) {
      const values = Array.from(match[4].matchAll(/'([^']*)'/g), (item) => item[1]);
      if (values.length === 0) continue;
      constraints.set(match[2], {
        constraint: match[2],
        table: match[1],
        column: match[3],
        values,
        migration: file,
      });
    }

    // The inline form, inside CREATE TABLE. Only taken when the constraint is
    // not already known, so a later ALTER always wins.
    const inlinePattern =
      /CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(\s*"([^"]+)"\s+IN\s*\(([\s\S]*?)\)\s*\)/gi;
    for (const match of sql.matchAll(inlinePattern)) {
      if (constraints.has(match[1])) continue;
      const values = Array.from(match[3].matchAll(/'([^']*)'/g), (item) => item[1]);
      if (values.length === 0) continue;
      constraints.set(match[1], {
        constraint: match[1],
        table: null,
        column: match[2],
        values,
        migration: file,
      });
    }
  }

  return [...constraints.values()].sort((left, right) =>
    left.constraint < right.constraint ? -1 : 1
  );
};

/**
 * @param constraints from `readEnumConstraints`
 * @param registry    `{ [constraintName]: entry }`, see the runner
 * @param resolve     `(entry) => string[] | null` for entries that own a list
 */
export const auditEnumConstraints = ({ constraints, registry, resolve }) => {
  const problems = [];
  const seen = new Set();

  for (const constraint of constraints) {
    const entry = registry[constraint.constraint];
    seen.add(constraint.constraint);

    // An unregistered constraint is the case this check exists to prevent:
    // somebody adds a closed list to the schema and nothing records whether
    // the application knows about it.
    if (!entry) {
      problems.push({
        kind: "unregistered",
        constraint: constraint.constraint,
        message:
          `${constraint.table ?? "?"}.${constraint.column} enforces a closed list ` +
          `of ${constraint.values.length} value(s) and has no registry entry.`,
      });
      continue;
    }

    if (!entry.reason || entry.reason.trim() === "") {
      problems.push({
        kind: "no_reason",
        constraint: constraint.constraint,
        message: `${constraint.constraint} has a registry entry with no reason.`,
      });
    }

    if (entry.owner !== "list") continue;

    const codeValues = resolve(entry);
    if (!codeValues) {
      problems.push({
        kind: "missing_list",
        constraint: constraint.constraint,
        message: `${constraint.constraint} names ${entry.list}, which does not exist.`,
      });
      continue;
    }

    const database = [...constraint.values].sort();
    const code = [...codeValues].sort();
    const onlyInDatabase = database.filter((value) => !code.includes(value));
    const onlyInCode = code.filter((value) => !database.includes(value));

    if (onlyInDatabase.length > 0 || onlyInCode.length > 0) {
      problems.push({
        kind: "mismatch",
        constraint: constraint.constraint,
        message:
          `${constraint.constraint} and ${entry.list} disagree.` +
          (onlyInCode.length
            ? `\n      code accepts, database rejects (a 500 where a 400 belongs): ${onlyInCode.join(", ")}`
            : "") +
          (onlyInDatabase.length
            ? `\n      database accepts, code never emits (dead configuration): ${onlyInDatabase.join(", ")}`
            : ""),
      });
    }

    if (new Set(constraint.values).size !== constraint.values.length) {
      problems.push({
        kind: "duplicate",
        constraint: constraint.constraint,
        message: `${constraint.constraint} lists the same value twice.`,
      });
    }
  }

  // A registry entry for a constraint the schema no longer has is the same
  // failure as a stale allowlist: it stops describing anything and nobody
  // notices it has stopped.
  for (const name of Object.keys(registry)) {
    if (seen.has(name)) continue;
    problems.push({
      kind: "stale_entry",
      constraint: name,
      message: `${name} is registered but no longer exists in the schema.`,
    });
  }

  return problems;
};
