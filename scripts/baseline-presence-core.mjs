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
 * of the existing function body. The guard proceeds only when that exact old
 * version is present; an absent, newer, or unknown version remains blocked.
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
 * not exactly the form above with a plain identifier. Both mean the guard cannot
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

/**
 * Which pending migrations name a relation, and which do not.
 *
 * Any entry in `undeclared` (no declaration, or an invalid one) means the guard
 * cannot prove absence for the set and must refuse as before.
 */
export const pendingProbes = (pending, sqlOf) => {
  const probes = [];
  const undeclared = [];
  for (const name of pending) {
    const declaration = presenceDeclarationIn(sqlOf(name));
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
