// Read-only report: purchased-credit lots that violate the §9 non-negative
// invariant, and whether the constraints guarding it are validated yet.
//
//   npm run report:credit-lot-invariants
//   npm run report:credit-lot-invariants -- --json
//
// This is the survey that gates validating the CHECK constraints added in
// 20260812070000_credit_lot_non_negative. They ship NOT VALID, so they
// enforce every write from that deploy onward but say nothing about rows that
// already existed -- deliberately, because a validating constraint would have
// made the deploy itself fail on data nobody had looked at.
//
// The sequence this belongs to:
//
//   1. the NOT VALID migration deploys;
//   2. this runs against production and reports violating rows;
//   3. once it reads zero, a follow-up migration VALIDATEs the constraints.
//
// Read-only, and stays that way. Every statement below is a SELECT. A
// negative balance is a ledger fact, not a typo: correcting one means writing
// a compensating CreditLedgerEntry so the row and its history still agree,
// which is a decision with an owner and not something a report should take.
//
// Requires DATABASE_URL. Point it at a read-only role.

import { prisma } from "../lib/prisma.ts";

const json = process.argv.includes("--json");

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is required. Point it at a read-only role on the database " +
      "whose lots you want surveyed."
  );
  process.exit(1);
}

const CONSTRAINTS = [
  "CreditLot_remainingCredits_non_negative_check",
  "CreditLot_remainingFundedCost_non_negative_check",
];

const constraintState = await prisma.$queryRaw`
  SELECT con.conname AS name, con.convalidated AS validated
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'CreditLot'
    AND con.contype = 'c'
    AND con.conname = ANY(${CONSTRAINTS})
`;

const violations = await prisma.$queryRaw`
  SELECT "id", "userId", "purchaseId", "source", "status",
         "remainingCredits",
         "remainingFundedCostMicroUsd",
         "originalCredits",
         "createdAt"
  FROM "CreditLot"
  WHERE "remainingCredits" < 0
     OR "remainingFundedCostMicroUsd" < 0
  ORDER BY "createdAt" ASC
`;

// BigInt columns cannot be JSON.stringify'd, and rounding them to Number would
// quietly change the very figures this report exists to state exactly.
const printable = violations.map((row) => ({
  ...row,
  remainingFundedCostMicroUsd: String(row.remainingFundedCostMicroUsd),
  createdAt: row.createdAt.toISOString(),
}));

const missing = CONSTRAINTS.filter(
  (name) => !constraintState.some((row) => row.name === name)
);
const unvalidated = constraintState
  .filter((row) => !row.validated)
  .map((row) => row.name);

const report = {
  constraints: {
    expected: CONSTRAINTS,
    missing,
    unvalidated,
    validated: constraintState
      .filter((row) => row.validated)
      .map((row) => row.name),
  },
  violationCount: printable.length,
  violations: printable,
  // "There is something left to validate, and it is safe to." Once the
  // follow-up migration has run there is nothing left, and a report still
  // reading `true` would go on telling the next operator to write a migration
  // that is already in the tree.
  readyToValidate:
    missing.length === 0 && unvalidated.length > 0 && printable.length === 0,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (missing.length > 0) {
    console.log(
      `Constraints not present on this database: ${missing.join(", ")}.\n` +
        "The NOT VALID migration has not been deployed here yet, so the\n" +
        "violation count below describes data nothing is currently guarding."
    );
  }
  if (unvalidated.length > 0) {
    console.log(`Present but NOT VALID: ${unvalidated.join(", ")}.`);
  }
  if (report.constraints.validated.length > 0) {
    console.log(`Validated: ${report.constraints.validated.join(", ")}.`);
  }

  console.log(`\nLots violating the non-negative invariant: ${printable.length}`);
  for (const row of printable) {
    console.log(
      `  ${row.id}  user=${row.userId}  source=${row.source}  ` +
        `status=${row.status}  credits=${row.remainingCredits}  ` +
        `fundedCostMicroUsd=${row.remainingFundedCostMicroUsd}  ` +
        `created=${row.createdAt}`
    );
  }

  if (report.readyToValidate) {
    console.log(
      "\nReady to validate: add the follow-up migration with\n" +
        CONSTRAINTS.map(
          (name) => `  ALTER TABLE "CreditLot" VALIDATE CONSTRAINT "${name}";`
        ).join("\n")
    );
  } else if (missing.length === 0 && unvalidated.length === 0) {
    console.log(
      "\nNothing left to validate: both constraints are validated on this\n" +
        "database, so Postgres has checked every existing row as well as every\n" +
        "write. Re-run this after an incident, not as a step."
    );
  } else {
    console.log(
      "\nNot ready to validate. Correct each row above with a compensating\n" +
        "CreditLedgerEntry -- never by editing the balance alone, which would\n" +
        "leave the row and its history disagreeing -- then re-run this."
    );
  }
}

await prisma.$disconnect();
