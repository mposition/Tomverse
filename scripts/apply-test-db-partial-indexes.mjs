// Gives the integration test database the constraints `prisma db push` cannot
// create.
//
// The DB integration suite syncs its database from prisma/schema.prisma with
// `db push`, because the migration history is not replayable from empty. That
// works for everything schema.prisma can express -- and silently omits
// everything it cannot. A partial unique index is the case that matters:
// PlanChangeRequest has `UNIQUE (userId) WHERE status = 'pending'`, which is
// what stops two racing confirms from booking competing plan changes against
// one subscription. Production has it, because production applies migrations;
// the test database did not, so the test written to prove that guarantee exists
// was asserting against a database that never had it.
//
// So the partial unique indexes are read back out of the migrations that
// created them and applied after `db push`. Sourced rather than copied: a new
// one added to a migration is picked up here without anybody remembering to.
//
// Only partial UNIQUE indexes are in scope. Ordinary indexes are already in
// schema.prisma, and the point is to close the gap between what production
// enforces and what the tests can observe -- not to become a second migration
// runner.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/**
 * Partial unique index statements found in migration SQL, rewritten to be
 * re-runnable against a database that may already have them.
 */
export const findPartialUniqueIndexes = (sql) => {
    const statements = sql.match(
        /CREATE\s+UNIQUE\s+INDEX\b[^;]*?\bWHERE\b[^;]*;/gis
    );
    if (!statements) return [];
    return statements.map((statement) =>
        statement
            .replace(
                /^CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/i,
                "CREATE UNIQUE INDEX IF NOT EXISTS "
            )
            .trim()
    );
};

export const collectPartialUniqueIndexes = (migrationsDirectory) =>
    readdirSync(migrationsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => {
            try {
                return findPartialUniqueIndexes(
                    readFileSync(
                        join(migrationsDirectory, entry.name, "migration.sql"),
                        "utf8"
                    )
                );
            } catch {
                return [];
            }
        });

// Importing this module for its helpers must not run the command.
const invokedDirectly =
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    const root = process.cwd();
    const statements = collectPartialUniqueIndexes(
        join(root, "prisma/migrations")
    );

    if (statements.length === 0) {
        console.log(
            "No partial unique indexes in the migrations; nothing to apply."
        );
        process.exit(0);
    }

    const file = join(tmpdir(), `tomverse-partial-indexes-${process.pid}.sql`);
    writeFileSync(file, `${statements.join("\n")}\n`, "utf8");

    const result = spawnSync(
        process.execPath,
        // Prisma 7's `db execute` takes its datasource from prisma.config.ts;
        // it has no --schema option, and the runner has already pointed
        // DATABASE_URL at the dedicated test database.
        ["node_modules/prisma/build/index.js", "db", "execute", "--file", file],
        { cwd: root, env: process.env, stdio: "inherit" }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);

    console.log(
        `Applied ${statements.length} partial unique index(es) that db push cannot express.`
    );
}
