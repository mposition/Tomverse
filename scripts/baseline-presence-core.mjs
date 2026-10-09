/**
 * What the baseline guard does with a migration `schema.prisma` cannot see.
 *
 * `scripts/baseline-existing-database.mjs` refuses a deploy when migrations are
 * pending *and* the database already matches `schema.prisma` -- the signature of
 * a restore that paired a current schema with an older `_prisma_migrations`.
 * That inference holds only for migrations whose effect `prisma migrate diff`
 * can see. A migration that adds a partial or expression index (or a CHECK
 * constraint, a trigger, a function) changes nothing the diff compares, so the
 * database "matches" both before and after it is applied, and the guard refused
 * the first such migration to ship on its own (2026-10-02,
 * `20261002120000_marketing_webhook_shadow_event_unique`): an ordinary pending
 * migration read as an already-applied one.
 *
 * A migration the diff cannot see may name the one relation it creates, in its
 * header comment block:
 *
 *     -- baseline-check: present-if-relation "Some_index_or_table_name"
 *
 * A CREATE OR REPLACE FUNCTION migration must instead pin the SHA-256 digest
 * of the existing function body. A migration that replaces CHECK constraints
 * after its SQL checksum has already shipped cannot add a header without
 * invalidating Prisma's checksum. It may carry a `baseline-check.json` sidecar
 * that pins the canonical migration digest and every exact prior
 * `pg_get_constraintdef` digest instead. The guard proceeds only when every
 * old version is present; an absent, newer, partial, or unknown state remains
 * blocked.
 *
 * **A name, not SQL.** The guard asks the one fixed question itself --
 * `SELECT to_regclass($1) IS NOT NULL` with the name bound as a parameter -- so
 * a migration cannot make the guard run anything else. (An earlier draft
 * accepted any SELECT; review pointed out that `dblink_exec` writes on another
 * connection that no read-only transaction or rollback covers.)
 *
 * The declaration is read only from the header -- the comment lines before the
 * first statement -- and there must be exactly one. A second one, a malformed
 * one, or one buried in a function body later in the file is not a
 * declaration, and the guard refuses as it always did.
 *
 * Only when every pending migration proves its new object absent or its old
 * function body exact does the deploy go on. Anything else keeps the original
 * refusal. Nothing here ever marks a migration applied.
 *
 * Pure: no database, no filesystem.
 */

import { createHash } from "node:crypto";

/** An unquoted PostgreSQL identifier's characters, at most 63 of them. */
const RELATION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const DECLARATION_PREFIX = /^--[ \t]*baseline-check:/;
const DECLARATION =
  /^--[ \t]*baseline-check:[ \t]*present-if-(relation|function)[ \t]+"([^"]*)"[ \t]*$/;
const REPLACEMENT_DECLARATION =
  /^--[ \t]*baseline-check:[ \t]*replace-function-if-body-sha256[ \t]+"([^"]*)"[ \t]+"([0-9a-f]{64})"[ \t]*$/;
const TEXT_FUNCTION_SIGNATURE = /^([A-Za-z_][A-Za-z0-9_]{0,62})\((text(?:,text){0,15})\)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SUPPLEMENTAL_KEYS = ["migrationSqlSha256", "replacedChecks", "version"];
const CHECK_KEYS = ["constraint", "previousDefinitionSha256", "table"];

const exactKeys = (value, expected) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

/** Preserve every byte-level distinction except checkout CRLF conversion. */
export const canonicalMigrationSqlSha256 = (sql) => {
  if (typeof sql !== "string") return undefined;
  return createHash("sha256")
    .update(sql.replaceAll("\r\n", "\n"), "utf8")
    .digest("hex");
};

/** Remove comments without treating comment markers in SQL literals as comments. */
const withoutSqlComments = (sql) => {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    if (sql[index] === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      out += "\n";
      index += 1;
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          if (sql[index] === "\n") out += "\n";
          index += 1;
        }
      }
      if (depth !== 0) return undefined;
      continue;
    }
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index];
      out += quote;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        out += sql[index];
        if (sql[index] === quote && sql[index + 1] === quote) {
          out += sql[index + 1];
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return undefined;
      continue;
    }
    // CHECK-only proof intentionally has no procedural/dollar-quoted form.
    if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) return undefined;
    out += sql[index];
    index += 1;
  }
  return out;
};

/** Split only outside literals and balanced parentheses; uncertainty is invalid. */
const splitSqlAt = (sql, delimiter) => {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const quote = char;
      let closed = false;
      for (index += 1; index < sql.length; index += 1) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 1;
          continue;
        }
        if (sql[index] === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) return undefined;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (char === delimiter && depth === 0) {
      parts.push(sql.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (depth !== 0) return undefined;
  parts.push(sql.slice(start).trim());
  return parts;
};

/**
 * The entire grammar a CHECK sidecar may prove: optional BEGIN/COMMIT and one
 * or more ALTER TABLE statements made solely of adjacent DROP + ADD CHECK
 * pairs under the same table/name. Anything else is deliberately invalid.
 */
export const replacedCheckTargetsIn = (sql) => {
  if (typeof sql !== "string") return { kind: "none" };
  const uncommented = withoutSqlComments(sql);
  const statements = uncommented === undefined ? undefined : splitSqlAt(uncommented, ";");
  if (!statements) return { kind: "invalid" };
  const checks = [];
  const seen = new Set();
  for (const statement of statements.filter(Boolean)) {
    if (/^(?:BEGIN|COMMIT)$/i.test(statement)) continue;
    const alter = /^ALTER\s+TABLE\s+(?:"public"\.)?"([A-Za-z_][A-Za-z0-9_]{0,62})"\s+([\s\S]+)$/i.exec(statement);
    if (!alter) return { kind: "invalid" };
    const actions = splitSqlAt(alter[2], ",");
    if (!actions || actions.length === 0 || actions.length % 2 !== 0) {
      return { kind: "invalid" };
    }
    for (let index = 0; index < actions.length; index += 2) {
      const dropped = /^DROP\s+CONSTRAINT\s+"([A-Za-z_][A-Za-z0-9_]{0,62})"$/i.exec(
        actions[index],
      );
      const added = /^ADD\s+CONSTRAINT\s+"([A-Za-z_][A-Za-z0-9_]{0,62})"\s+CHECK\s*\([\s\S]*\)$/i.exec(
        actions[index + 1],
      );
      if (!dropped || !added || dropped[1] !== added[1]) return { kind: "invalid" };
      const table = alter[1];
      const constraint = dropped[1];
      const identity = `${table}\0${constraint}`;
      if (seen.has(identity)) return { kind: "invalid" };
      seen.add(identity);
      checks.push({ table, constraint });
    }
  }
  return checks.length === 0 ? { kind: "none" } : { kind: "check-replacement", checks };
};

/**
 * Validate the data-only sidecar against both the migration bytes and every
 * CHECK replacement named by the SQL. The sidecar carries data, never SQL.
 */
export const supplementalProofIn = (sql, json) => {
  if (json === undefined) return { kind: "none" };
  if (typeof json !== "string") return { kind: "invalid" };
  let proof;
  try {
    proof = JSON.parse(json);
  } catch {
    return { kind: "invalid" };
  }
  if (!exactKeys(proof, SUPPLEMENTAL_KEYS) || proof.version !== 1) {
    return { kind: "invalid" };
  }
  const sqlDigest = canonicalMigrationSqlSha256(sql);
  if (!SHA256.test(proof.migrationSqlSha256) || proof.migrationSqlSha256 !== sqlDigest) {
    return { kind: "invalid" };
  }
  const replacements = replacedCheckTargetsIn(sql);
  if (
    replacements.kind !== "check-replacement" ||
    !Array.isArray(proof.replacedChecks)
  ) {
    return { kind: "invalid" };
  }
  if (proof.replacedChecks.length !== replacements.checks.length) {
    return { kind: "invalid" };
  }
  const checks = [];
  for (let index = 0; index < proof.replacedChecks.length; index += 1) {
    const entry = proof.replacedChecks[index];
    const target = replacements.checks[index];
    if (
      !exactKeys(entry, CHECK_KEYS) ||
      !RELATION_NAME.test(entry.table) ||
      !RELATION_NAME.test(entry.constraint) ||
      !SHA256.test(entry.previousDefinitionSha256) ||
      entry.table !== target.table ||
      entry.constraint !== target.constraint
    ) {
      return { kind: "invalid" };
    }
    checks.push({
      table: entry.table,
      constraint: entry.constraint,
      previousDefinitionSha256: entry.previousDefinitionSha256,
    });
  }
  return { kind: "check-replacement", checks };
};

/** The comment lines before the first statement; blank lines are skipped. */
const headerLines = (sql) => {
  const lines = [];
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("--")) break;
    lines.push(line);
  }
  return lines;
};

/**
 * The object or replacement a migration declares, or why it declares none.
 *
 * `none`: no declaration in the header. `invalid`: more than one, or one that is
 * not exactly the approved plain identifier or typed function signature. Both mean the guard cannot
 * prove this migration absent.
 */
export const presenceDeclarationIn = (sql) => {
  if (typeof sql !== "string") return { kind: "none" };
  const declarations = headerLines(sql).filter((line) => DECLARATION_PREFIX.test(line));
  if (declarations.length === 0) return { kind: "none" };
  if (declarations.length > 1) return { kind: "invalid" };
  const replacement = REPLACEMENT_DECLARATION.exec(declarations[0]);
  if (replacement) {
    const signature = TEXT_FUNCTION_SIGNATURE.exec(replacement[1]);
    if (!RELATION_NAME.test(replacement[1]) && !signature) return { kind: "invalid" };
    return {
      kind: "function-replacement",
      function: signature?.[1] ?? replacement[1],
      ...(signature ? { functionArgs: signature[2].split(",") } : {}),
      previousBodySha256: replacement[2],
    };
  }
  const match = DECLARATION.exec(declarations[0]);
  if (!match || !RELATION_NAME.test(match[2])) return { kind: "invalid" };
  if (match[1] === "function") return { kind: "function", function: match[2] };
  return { kind: "relation", relation: match[2] };
};

/** The fixed question, with the name as a bound parameter -- never as SQL text. */
export const presenceQuery = (relation) => ({
  text: 'SELECT to_regclass($1) IS NOT NULL AS "present"',
  values: [`public."${relation}"`],
  rowMode: "array",
});

/**
 * The fixed question for a migration that creates only a function -- which is
 * not a relation, so to_regclass cannot see it (2026-10-03,
 * `20261003130000_support_triage_arm_timeouts`, refused on staging). Any
 * overload in public counts as present: EXISTS always answers one boolean,
 * where to_regproc would have to choose among overloads.
 */
export const functionPresenceQuery = (name) => ({
  text:
    'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = \'public\' AND p.proname = $1) AS "present"',
  values: [name],
  rowMode: "array",
});

/** Read only the exact existing function body for a replacement. */
export const functionBodyQuery = (name, functionArgs = []) =>
  functionArgs.length === 0 ? {
    text:
      "SELECT p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1 AND p.pronargs = 0 AND p.prorettype = 'pg_catalog.trigger'::regtype",
    values: [name], rowMode: "array",
  } : {
    text:
      "SELECT p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1 AND p.oid = pg_catalog.to_regprocedure($2)",
    values: [name, `public."${name}"(${functionArgs.join(",")})`], rowMode: "array",
  };

/** Read only one named CHECK definition in public; both names stay bound data. */
export const checkDefinitionQuery = ({ table, constraint }) => ({
  text:
    "SELECT pg_catalog.pg_get_constraintdef(c.oid, false) FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = $1 AND c.conname = $2 AND c.contype = 'c'",
  values: [table, constraint],
  rowMode: "array",
});

/** The fixed question for one probe from `pendingProbes`. */
export const presenceQueryFor = (probe) =>
  probe.previousBodySha256 !== undefined
    ? functionBodyQuery(probe.function, probe.functionArgs)
    : probe.function !== undefined
      ? functionPresenceQuery(probe.function)
      : presenceQuery(probe.relation);

/**
 * The answer, or undefined when it is not exactly one row of one boolean.
 * `rows` is pg's array-mode result.
 */
export const presenceAnswer = (rows) => {
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row = rows[0];
  if (!Array.isArray(row) || row.length !== 1) return undefined;
  return typeof row[0] === "boolean" ? row[0] : undefined;
};

/** Only the exact previous function version permits CREATE OR REPLACE. */
export const replacementAnswer = (rows, previousBodySha256) => {
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row = rows[0];
  if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== "string") {
    return undefined;
  }
  const actual = createHash("sha256").update(row[0], "utf8").digest("hex");
  return actual === previousBodySha256 ? false : true;
};

/** Only the exact previous CHECK definition permits DROP + ADD replacement. */
export const checkReplacementAnswer = (rows, previousDefinitionSha256) => {
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row = rows[0];
  if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== "string") {
    return undefined;
  }
  const actual = createHash("sha256").update(row[0], "utf8").digest("hex");
  return actual === previousDefinitionSha256 ? false : true;
};

/** All prior definitions are required; a mixed or unknown state stays blocked. */
export const checkReplacementSetAnswer = (answers) => {
  if (!Array.isArray(answers) || answers.length === 0) return undefined;
  if (answers.some((answer) => answer === true)) return true;
  if (answers.some((answer) => answer !== false)) return undefined;
  return false;
};

/**
 * Which pending migrations name a relation, and which do not.
 *
 * Any entry in `undeclared` (no declaration, or an invalid one) means the guard
 * cannot prove absence for the set and must refuse as before.
 */
export const pendingProbes = (pending, sqlOf, supplementalOf = () => undefined) => {
  const probes = [];
  const undeclared = [];
  for (const name of pending) {
    const sql = sqlOf(name);
    const declaration = presenceDeclarationIn(sql);
    const supplemental = supplementalProofIn(sql, supplementalOf(name));
    if (supplemental.kind === "invalid") {
      undeclared.push(name);
      continue;
    }
    if (supplemental.kind === "check-replacement") {
      if (declaration.kind !== "none") {
        undeclared.push(name);
        continue;
      }
      probes.push({ name, replacedChecks: supplemental.checks });
      continue;
    }
    if (declaration.kind === "relation") probes.push({ name, relation: declaration.relation });
    else if (declaration.kind === "function") probes.push({ name, function: declaration.function });
    else if (declaration.kind === "function-replacement") {
      probes.push({
        name,
        function: declaration.function,
        ...(declaration.functionArgs ? { functionArgs: declaration.functionArgs } : {}),
        previousBodySha256: declaration.previousBodySha256,
      });
    }
    else undeclared.push(name);
  }
  return { probes, undeclared };
};

/**
 * The guard's answer once every probe has run. Only an all-`false` set lets the
 * deploy proceed; `true`, `undefined` or a missing answer is "may be present".
 */
export const presenceVerdict = (pending, answers) => {
  const notProvenAbsent = pending.filter((name) => answers.get(name) !== false);
  return { proceed: notProvenAbsent.length === 0, notProvenAbsent };
};
