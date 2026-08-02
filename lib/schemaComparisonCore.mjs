/**
 * The comparison half of `npm run db:compare-schema`, separated from the
 * database access so it can be tested without a PostgreSQL server.
 *
 * Plain `.mjs` because the script that uses it runs under bare node during a
 * release, before any TypeScript loader is guaranteed to be present.
 *
 * The three outcomes are kept apart because their causes and their
 * corrections differ:
 *
 *   only_in_source      an object the migration history does not create, so
 *                       every new environment is missing it. Applied by hand,
 *                       or owned by an extension.
 *   only_in_database    the source is behind the history, or the object was
 *                       dropped outside it.
 *   definition_mismatch the same name exists on both sides and means
 *                       something different.
 *
 * The third is the reason this exists. A plain set difference describes a
 * redefinition as "one object missing, one object added" -- true, and it
 * buries the only fact that matters: the name still resolves, so every
 * "does it exist" check passes while the thing behind the name has changed.
 * The incident in this repository was exactly that shape, a partial unique
 * index that kept its name and lost its predicate.
 */

/**
 * @typedef {{ key: string, source: string, database: string }} DefinitionMismatch
 * @typedef {{
 *   section: string,
 *   onlyInSource: string[],
 *   onlyInDatabase: string[],
 *   definitionMismatch: DefinitionMismatch[],
 *   identicalCount: number,
 *   differenceCount: number,
 * }} SectionComparison
 */

/**
 * Compares one section (columns, indexes, constraints, ...).
 *
 * Both sides are `Map<identity, definition>`. Splitting each row into an
 * identity and a definition is what makes a redefinition expressible at all:
 * two sets of opaque strings can only ever report addition and removal.
 *
 * @param {string} section
 * @param {Map<string, string>} source      the live database being audited
 * @param {Map<string, string>} database    the schema built from migrations
 * @returns {SectionComparison}
 */
export const compareSchemaSection = (section, source, database) => {
  const onlyInSource = [];
  const onlyInDatabase = [];
  const definitionMismatch = [];
  let identicalCount = 0;

  for (const [key, definition] of source) {
    if (!database.has(key)) {
      onlyInSource.push(`${key} :: ${definition}`);
    } else if (database.get(key) !== definition) {
      definitionMismatch.push({
        key,
        source: definition,
        database: database.get(key),
      });
    } else {
      identicalCount += 1;
    }
  }
  for (const [key, definition] of database) {
    if (!source.has(key)) onlyInDatabase.push(`${key} :: ${definition}`);
  }

  return {
    section,
    onlyInSource,
    onlyInDatabase,
    definitionMismatch,
    identicalCount,
    differenceCount:
      onlyInSource.length + onlyInDatabase.length + definitionMismatch.length,
  };
};

/**
 * Compares every section and totals the three classifications.
 *
 * @param {Record<string, Map<string, string>>} source
 * @param {Record<string, Map<string, string>>} database
 * @param {readonly string[]} sections
 */
export const compareSchemas = (source, database, sections) => {
  const comparisons = sections.map((section) =>
    compareSchemaSection(
      section,
      source[section] ?? new Map(),
      database[section] ?? new Map()
    )
  );

  const totals = {
    only_in_source: 0,
    only_in_database: 0,
    definition_mismatch: 0,
  };
  for (const comparison of comparisons) {
    totals.only_in_source += comparison.onlyInSource.length;
    totals.only_in_database += comparison.onlyInDatabase.length;
    totals.definition_mismatch += comparison.definitionMismatch.length;
  }

  return {
    comparisons,
    totals,
    differenceCount:
      totals.only_in_source + totals.only_in_database + totals.definition_mismatch,
  };
};

/**
 * Strips anything that looks like a connection string out of text that is
 * about to be printed.
 *
 * The URLs are only ever read from the environment, but PostgreSQL and Prisma
 * both echo them in error messages, and this output is meant to be kept as
 * operational evidence and attached to a ticket. Applied to every printed
 * line, including failures, rather than only to the ones expected to contain
 * one.
 */
export const redactConnectionStrings = (text) =>
  String(text).replace(
    /postgres(?:ql)?:\/\/[^\s"']+/gi,
    "[redacted-connection-string]"
  );
