// Read-only survey: knowledge rows that would violate the non-negative
// invariants, and whether the constraints guarding them are validated yet.
//
//   npm run report:assistant-knowledge-invariants
//   npm run report:assistant-knowledge-invariants -- --json
//
// This is the survey that gates validating the CHECK added NOT VALID in
// 20260823090000_assistant_package_import. The sequence, the same one
// `CreditLot` used:
//
//   1. the NOT VALID migration deploys;
//   2. this runs against production and reports the violating row count;
//   3. once it reads zero, a follow-up migration VALIDATEs the constraint.
//
// Do not validate by hand between (1) and (3): `compare-schema-to-migrations`
// reads `pg_get_constraintdef()`, whose output carries the `NOT VALID` suffix,
// so a hand-validated production reads as drift until the follow-up migration
// exists.
//
// ## Why this reports counts and not rows
//
// The `CreditLot` report prints the offending rows because correcting one
// means writing a compensating ledger entry against that specific lot -- the
// operator cannot act without the id. Here the recommended action is not to
// correct anything: docs/policy/assistant-package-import.md §10 settles that
// existing rows are not re-extracted, and a negative character count is a
// processing result rather than a typo. So an id here is something the reader
// cannot act on, and the survey's own record is committed to a repository. A
// count answers the only question being asked -- may the constraint be
// validated -- without putting an account or file identifier anywhere.
//
// Read-only, and stays that way: every statement below is a SELECT.
//
// Requires DATABASE_URL. Point it at a read-only role.

import { prisma } from "../lib/prisma.ts";

const json = process.argv.includes("--json");

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is required. Point it at a read-only role on the database " +
      "whose knowledge rows you want surveyed."
  );
  process.exit(1);
}

/**
 * Both constraints on the table, deliberately.
 *
 * Only the first is NOT VALID and only the first is what the follow-up
 * migration is for; the second is reported beside it because "the column that
 * was added with the fix is guarded" is part of the same answer, and an
 * operator reading one number should not have to go and check the other.
 */
const CONSTRAINTS = [
  "AssistantKnowledgeFile_extractedCharacters_non_negative_check",
  "AssistantKnowledgeFile_extractedBytes_non_negative_check",
];

/** The one the survey gates. */
const GATED_CONSTRAINT = CONSTRAINTS[0];

const constraintState = await prisma.$queryRaw`
  SELECT con.conname AS name, con.convalidated AS validated
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'AssistantKnowledgeFile'
    AND con.contype = 'c'
    AND con.conname = ANY(${CONSTRAINTS})
`;

const [counts] = await prisma.$queryRaw`
  SELECT
    COUNT(*) FILTER (WHERE "extractedCharacters" < 0) AS negative_characters,
    COUNT(*) FILTER (WHERE "extractedBytes" < 0)      AS negative_bytes
  FROM "AssistantKnowledgeFile"
`;

// COUNT returns BigInt, which JSON.stringify refuses and Number() would
// silently round past 2^53. These counts are small in every plausible world,
// and the point of the report is to be exact about a number somebody acts on.
const negativeCharacters = Number(counts.negative_characters);
const negativeBytes = Number(counts.negative_bytes);

const missing = CONSTRAINTS.filter(
  (name) => !constraintState.some((row) => row.name === name)
);
const unvalidated = constraintState
  .filter((row) => !row.validated)
  .map((row) => row.name);

const report = {
  constraints: {
    expected: CONSTRAINTS,
    gated: GATED_CONSTRAINT,
    missing,
    unvalidated,
    validated: constraintState
      .filter((row) => row.validated)
      .map((row) => row.name),
  },
  violationCount: negativeCharacters + negativeBytes,
  violations: {
    extractedCharacters: negativeCharacters,
    extractedBytes: negativeBytes,
  },
  // "There is something left to validate, and it is safe to." Once the
  // follow-up migration has run there is nothing left, and a report still
  // reading `true` would go on telling the next operator to write a migration
  // that is already in the tree.
  readyToValidate:
    !missing.includes(GATED_CONSTRAINT) &&
    unvalidated.includes(GATED_CONSTRAINT) &&
    negativeCharacters === 0 &&
    negativeBytes === 0,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (missing.length > 0) {
    console.log(
      `Constraints not present on this database: ${missing.join(", ")}.\n` +
        "The migration has not been deployed here yet, so the counts below\n" +
        "describe data nothing is currently guarding."
    );
  }
  if (unvalidated.length > 0) {
    console.log(`Present but NOT VALID: ${unvalidated.join(", ")}.`);
  }
  if (report.constraints.validated.length > 0) {
    console.log(`Validated: ${report.constraints.validated.join(", ")}.`);
  }

  console.log(`\nRows with a negative extractedCharacters: ${negativeCharacters}`);
  console.log(`Rows with a negative extractedBytes:      ${negativeBytes}`);
  console.log(
    "\nNo identifiers are printed on purpose -- see the note at the top of\n" +
      "this file. A non-zero count is a reason to investigate the extractor,\n" +
      "not to edit rows."
  );

  if (report.readyToValidate) {
    console.log(
      "\nReady to validate: add the follow-up migration with\n" +
        `  ALTER TABLE "AssistantKnowledgeFile" VALIDATE CONSTRAINT "${GATED_CONSTRAINT}";`
    );
  } else if (missing.length === 0 && unvalidated.length === 0) {
    console.log(
      "\nNothing left to validate: the constraint is validated on this\n" +
        "database, so Postgres has checked every existing row as well as every\n" +
        "write. Re-run this after an incident, not as a step."
    );
  } else if (negativeCharacters + negativeBytes > 0) {
    console.log(
      "\nNot ready to validate: a validating ALTER would fail on the rows\n" +
        "counted above. Find out what wrote them before deciding anything."
    );
  }
}

await prisma.$disconnect();
