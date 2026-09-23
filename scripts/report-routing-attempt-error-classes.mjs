// Read-only report: the `errorClass` values that already exist on
// RoutingAttempt, and whether the CHECK guarding the vocabulary can be
// validated yet.
//
//   npm run report:routing-attempt-error-classes
//   npm run report:routing-attempt-error-classes -- --json
//
// This is the survey that gates validating the constraint added in
// 20260922130000_routing_attempt_error_class_vocabulary (A-3b). It ships
// NOT VALID, so it enforces every write from that deploy onward and says
// nothing about rows that already existed -- deliberately, because a
// validating constraint would have made the deploy itself fail on data
// nobody had looked at.
//
// The sequence this belongs to, the same one report-credit-lot-invariants
// walks for its own constraints:
//
//   1. the NOT VALID migration deploys;
//   2. this runs against production and reports every distinct value;
//   3. once it reads zero unknown values, a follow-up migration VALIDATEs.
//
// Do not run `VALIDATE CONSTRAINT` by hand in production. The schema
// comparison reads that as drift, and the next deploy fights it.
//
// ## What this prints, and what it deliberately does not
//
// Class names and counts. Nothing else: no user id, no trace id, no model
// id, no provider error text, no timestamps finer than a date range. The
// output is safe to paste anywhere, and that is a property of what is
// selected rather than a promise about the data.
//
// `errorClass` was designed as a fixed classification and never carries
// provider prose -- lib/routingAttemptStore.ts says so and the CHECK is what
// makes it true going forward. This report is how we find out whether it was
// true backwards as well.
//
// Requires DATABASE_URL. Point it at a read-only role.

import { prisma } from "../lib/prisma.ts";
import { ROUTING_ATTEMPT_ERROR_CLASSES } from "../lib/routingAttemptStore.ts";

const json = process.argv.includes("--json");

const CONSTRAINT = "RoutingAttempt_errorClass_check";

const main = async () => {
    // Every distinct value and how many rows carry it. A GROUP BY rather than
    // a filtered count, because "is anything outside the list" and "what is
    // outside the list" are different questions and the second is the one
    // that tells somebody what to do next.
    const rows = await prisma.$queryRaw`
        SELECT "errorClass" AS class, COUNT(*)::int AS rows
        FROM "RoutingAttempt"
        GROUP BY "errorClass"
        ORDER BY COUNT(*) DESC
    `;

    // Whether the constraint exists at all, and whether it has been validated.
    // `convalidated` is false for a NOT VALID constraint and true once a
    // VALIDATE has run, so this says which step the sequence is on without
    // anybody having to remember.
    const constraint = await prisma.$queryRaw`
        SELECT conname AS name, convalidated AS validated
        FROM pg_constraint
        WHERE conrelid = '"RoutingAttempt"'::regclass
          AND conname = ${CONSTRAINT}
    `;

    const known = new Set(ROUTING_ATTEMPT_ERROR_CLASSES);
    const unknown = rows.filter(
        (row) => row.class !== null && !known.has(row.class)
    );
    const total = rows.reduce((sum, row) => sum + row.rows, 0);
    const classified = rows
        .filter((row) => row.class !== null)
        .reduce((sum, row) => sum + row.rows, 0);

    const state =
        constraint.length === 0
            ? "absent"
            : constraint[0].validated
              ? "validated"
              : "not_valid";

    if (json) {
        console.log(
            JSON.stringify(
                {
                    constraint: CONSTRAINT,
                    state,
                    attempts: total,
                    classified,
                    unclassified: total - classified,
                    values: rows.map((row) => ({
                        class: row.class,
                        rows: row.rows,
                        known: row.class === null || known.has(row.class),
                    })),
                    unknown: unknown.map((row) => row.class),
                    validatable: state === "not_valid" && unknown.length === 0,
                },
                null,
                2
            )
        );
        return;
    }

    console.log("");
    console.log("RoutingAttempt.errorClass");
    console.log("-------------------------");
    console.log(`Constraint ${CONSTRAINT}: ${state}.`);
    console.log(
        `${total} attempt row(s); ${classified} carry a class and ` +
            `${total - classified} carry null.`
    );
    console.log("");

    if (rows.length === 0) {
        console.log("No rows. Instrumentation has not written any attempts yet:");
        console.log("ROUTING_DISPATCH_INSTRUMENTATION is `off` unless set to");
        console.log("`observe` or `enforce`, and `off` writes nothing.");
        console.log("");
        console.log(
            "An empty table can be validated, and validating it proves nothing."
        );
        console.log("Wait for a real sample.");
        return;
    }

    for (const row of rows) {
        const label = row.class === null ? "(null)" : row.class;
        const mark =
            row.class === null || known.has(row.class) ? " " : "!";
        console.log(`  ${mark} ${String(row.rows).padStart(8)}  ${label}`);
    }
    console.log("");

    if (unknown.length > 0) {
        console.log(
            `${unknown.length} value(s) are outside ROUTING_ATTEMPT_ERROR_CLASSES,`
        );
        console.log("marked ! above. Each is a decision before VALIDATE:");
        console.log("");
        console.log("  - it belongs in the list   -> add it, in its own change,");
        console.log("                                with the reason it exists;");
        console.log("  - it was a writer mistake  -> the rows need correcting,");
        console.log("                                which is a migration with");
        console.log("                                an owner, not a report's job.");
        console.log("");
        console.log("VALIDATE would fail on these rows today.");
        process.exitCode = 1;
        return;
    }

    if (state === "validated") {
        console.log("Already validated. Nothing to do.");
        return;
    }
    if (state === "absent") {
        console.log(
            `${CONSTRAINT} is not on this database. The A-3b migration has not`
        );
        console.log("been applied here.");
        process.exitCode = 1;
        return;
    }

    console.log("Every existing value is in the list.");
    console.log("");
    console.log("The constraint can be validated. Do it in a migration:");
    console.log("");
    console.log(`  ALTER TABLE "RoutingAttempt"`);
    console.log(`      VALIDATE CONSTRAINT "${CONSTRAINT}";`);
    console.log("");
    console.log("VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes");
    console.log("continue while it scans. Running it by hand in production");
    console.log("makes the schema comparison report drift.");
};

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
