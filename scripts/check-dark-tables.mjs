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
];

/** Where runtime code lives. Anything outside this cannot serve a request. */
const ROOTS = ["app", "lib", "components", "scripts", "prisma/seed"];

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

        if (dotted.test(source) || bracketed.test(source) || rawSql.test(source)) {
            problems.push(`${file.split("\\").join("/")}: reads ${table}`);
        }
    }
}

console.log("");
console.log("Dark table check");
console.log("----------------");
console.log(
    `${files.length} runtime source file(s) scanned for ${DARK_TABLES.length} dark table(s).`
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
