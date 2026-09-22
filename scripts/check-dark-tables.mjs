// Tables that exist and nothing may read.
//
// `ModelDeployment`, `ProviderEndpoint` and `EndpointResidencyApproval` were
// added ahead of the work that will use them, on the condition that nothing
// reads or writes them until the routing identity change is approved
// separately. A condition nobody checks is a wish.
//
// The first version of this check was a test that grepped seven named files
// for `prisma.<delegate>`. That is not a boundary: a new API route, a cron, an
// admin panel, `tx.modelDeployment`, `client["modelDeployment"]` or raw SQL
// would all have passed it. An independent review said so, and it was right.
//
// This reads every runtime source in the repository instead, and looks for the
// delegate by any of the spellings that reach it, plus the table name inside
// raw SQL. Fail-closed: an unrecognised use is a failure, and the way to add
// one is to take the table off this list deliberately.
//
// Tests are excluded. `tests/deploymentIdentity.test.mjs` names the delegates
// in order to assert they are unused, and a check that forbade naming them
// would forbid checking them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The Prisma delegate names, and the table names raw SQL would use. */
const DARK_TABLES = [
    "ModelDeployment",
    "ProviderEndpoint",
    "EndpointResidencyApproval",
    "CredentialBinding",
    "QuotaScope",
    "ProviderRegistryEntry",
    "RoutingCandidateVerdict",
    "QuotaCapacityState",
    "AvailabilityObservation",
    "DeploymentCacheAffinity",
];


/**
 * Columns added to a table that is *not* dark, which nothing may read yet.
 *
 * `RoutingRun` is live and written every shadow run. Two columns on it are
 * not: `allocationMode` and `allocationSeedGrain` reserve the allocation axis
 * so that nobody reaches for `mode`, which answers a different question. They
 * are null on every row and a reader that found one would be reading a
 * decision nobody recorded.
 *
 * Matched as whole identifiers, because these names are distinctive enough
 * that any occurrence in runtime code is a use. A generic column name could
 * not be protected this way and should not be added to this list.
 */
const DARK_COLUMNS = ["allocationMode", "allocationSeedGrain"];

/**
 * The one file that may name a dark column: the module that defines the
 * vocabulary the column holds.
 *
 * Exempt for the reason this file is exempt from its own table list -- it
 * declares the names rather than reading rows. Narrow on purpose: it excuses
 * the column scan only, so the same file is still checked against every dark
 * table, and it names one file rather than a directory.
 */
const DARK_COLUMN_VOCABULARY = ["lib/routingAllocation.ts"];

/**
 * The relation fields that reach a dark table from a model that is not dark.
 *
 * Only those. A relation field declared on a dark model is reached by
 * querying that model, and the delegate pattern already catches it -- adding
 * it here would mean matching `approvals:` and `scope:`, which ordinary admin
 * and email code uses for its own purposes, and the check would fail on files
 * that never touch these tables.
 *
 * What is left is the case the delegate pattern genuinely misses:
 * `include: { cacheAffinities: true }` on a Conversation query reaches
 * DeploymentCacheAffinity without ever naming it. The names are read out of
 * the schema rather than guessed from the model name, because a Prisma
 * back-relation is named by whoever wrote it -- appending `s` would walk
 * straight past `cacheAffinities`.
 */
const RELATION_FIELDS = (() => {
    const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
    const byTable = Object.fromEntries(
        DARK_TABLES.map((table) => [
            table,
            [table.charAt(0).toLowerCase() + table.slice(1)],
        ])
    );

    let host = null;
    for (const line of schema.split("\n")) {
        const opening = /^model\s+(\w+)\s*\{/.exec(line);
        if (opening) {
            host = opening[1];
            continue;
        }
        if (line.startsWith("}")) {
            host = null;
            continue;
        }
        if (host === null || DARK_TABLES.includes(host)) continue;

        const field = /^\s+(\w+)\s+(\w+)(\[\])?\s*(@|$)/.exec(line);
        if (field && byTable[field[2]]) byTable[field[2]].push(field[1]);
    }

    return byTable;
})();

/** Where runtime code lives. Anything outside this cannot serve a request. */
const ROOTS = ["app", "lib", "components", "scripts", "packages", "prisma/seed"];

/** Paths that may name a dark table without reading it. */
const ALLOWED = [
    // The schema and its migration declare them; that is what they are for.
    "prisma/schema.prisma",
    "prisma/migrations",
    // This file lists them by name.
    "scripts/check-dark-tables.mjs",
];

const SOURCE = /\.(ts|tsx|mjs|js|cjs)$/;

const walk = (directory) => {
    const absolute = join(root, directory);
    let entries;
    try {
        entries = readdirSync(absolute);
    } catch {
        return [];
    }
    return entries.flatMap((entry) => {
        if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) {
            return [];
        }
        const path = join(absolute, entry);
        if (statSync(path).isDirectory()) {
            return walk(join(directory, entry));
        }
        return SOURCE.test(entry) ? [join(directory, entry)] : [];
    });
};

const files = ROOTS.flatMap((directory) => walk(directory)).filter((file) => {
    const normalised = relative(root, join(root, file)).split("\\").join("/");
    return !ALLOWED.some((allowed) => normalised.startsWith(allowed));
});

const problems = [];

for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const table of DARK_TABLES) {
        const delegate = table.charAt(0).toLowerCase() + table.slice(1);
        // `prisma.modelDeployment`, `tx.modelDeployment`, `client.modelDeployment`
        const dotted = new RegExp(`\\.\\s*${delegate}\\s*\\.`);
        // `prisma["modelDeployment"]`, `tx['modelDeployment']`
        const bracketed = new RegExp(`\\[\\s*["'\`]${delegate}["'\`]\\s*\\]`);
        // `FROM "ModelDeployment"`, `INSERT INTO "ModelDeployment"`, unquoted too
        const rawSql = new RegExp(
            `(from|into|update|join|table)\\s+"?${table}"?\\b`,
            "i"
        );

        // A relation field reaches the same rows without ever naming the
        // delegate: `include: { credentialBindings: true }` on a user query,
        // or a nested `create`. The field names come from the schema rather
        // than from pluralising the model name, because a Prisma back-relation
        // is named by whoever wrote it. An earlier version appended `s` and so
        // would have walked straight past `cacheAffinities`.
        const relation = new RegExp(
            `\\b(${RELATION_FIELDS[table].join("|")})\\s*:\\s*(true|\\{)`
        );

        if (
            dotted.test(source) ||
            bracketed.test(source) ||
            relation.test(source) ||
            rawSql.test(source)
        ) {
            problems.push(`${file.split("\\").join("/")}: reads ${table}`);
        }
    }

    const normalised = file.split("\\").join("/");
    for (const column of DARK_COLUMNS) {
        if (DARK_COLUMN_VOCABULARY.includes(normalised)) break;
        if (new RegExp(`\\b${column}\\b`).test(source)) {
            problems.push(
                `${normalised}: reads RoutingRun.${column}`
            );
        }
    }
}

console.log("");
console.log("Dark table check");
console.log("----------------");
console.log(
    `${files.length} runtime source file(s) scanned for ${DARK_TABLES.length} dark table(s) ` +
        `and ${DARK_COLUMNS.length} dark column(s).`
);

if (problems.length > 0) {
    console.error("");
    console.error("A dark table is being used:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    console.error(
        "These tables were added ahead of the work that uses them, on the condition\n" +
            "that nothing reads or writes them until the routing identity change is\n" +
            "approved on its own. If that approval has happened, take the table out of\n" +
            "DARK_TABLES in this file -- deliberately, in the same change that starts\n" +
            "using it."
    );
    process.exit(1);
}

console.log("");
console.log("None of them is read or written. That is the intended state.");
console.log("");
