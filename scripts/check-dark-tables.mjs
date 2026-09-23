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
    "RoutingIdentityManifest",
    "RoutingIdentityManifestEntry",
];


/**
 * Columns on a table that is *not* dark, which nothing may read or write yet.
 *
 * Three tables here are live and written on ordinary requests -- `RoutingRun`
 * every shadow run, `ProviderProbeResult` every probe cycle, `RoutingAttempt`
 * whenever instrumentation is on -- and some of their columns are not. The
 * table rule cannot cover those, so they are named.
 *
 * Each entry carries the files that may name it. `allocationMode` and
 * `allocationSeedGrain` are distinctive enough that any occurrence is a use;
 * `providerEndpointId` and `modelDeploymentId` are ordinary foreign key names
 * that three dark tables already spell in their own vocabulary modules, which
 * is why the exemption is per column and per file rather than one list. A file
 * not named here that writes one of these is what this stops.
 *
 * What a name scan cannot see, and this does not claim to: a Prisma read with
 * no `select` returns every scalar, so `scripts/verify-fallback-drill.mjs` and
 * the `create` in `lib/routingDispatchInstrumentation.ts` both receive columns
 * without naming them. Neither reads the values and every value is null, so
 * nothing is decided on them -- but this guards against a use being written,
 * not against a row reaching a caller. An identifier built by concatenation is
 * invisible to it for the same reason.
 */
const DARK_COLUMNS = [
    {
        column: "allocationMode",
        on: "RoutingRun",
        exempt: ["lib/routingAllocation.ts"],
    },
    {
        column: "allocationSeedGrain",
        on: "RoutingRun",
        exempt: ["lib/routingAllocation.ts"],
    },
    // The versions frozen when a request starts. The module names them
    // because it is the value those columns will store. It does not write
    // a row.
    {
        column: "controlPlaneVersion",
        on: "RoutingRun",
        exempt: ["lib/routingPinGate.ts"],
    },
    {
        column: "accountPolicyVersion",
        on: "RoutingRun",
        exempt: ["lib/routingPinGate.ts"],
    },
    // The deadline captured when a request starts. The module names it
    // because it is the value the column will store. It does not write a row.
    {
        column: "requestDeadlineMs",
        on: "RoutingRun",
        exempt: ["lib/routingResidualControls.ts"],
    },
    // How long the first chunk may be withheld. The module names the column
    // because it is the value that column will store. It does not write a row.
    {
        column: "precommitBufferMs",
        on: "RoutingRun",
        exempt: ["lib/routingPrecommitBuffer.ts"],
    },
    // The attempt's binding to a published manifest. Both names are spelled
    // only by the module that defines the manifest shape.
    {
        column: "identityManifestId",
        on: "RoutingAttempt",
        exempt: ["lib/routingIdentityManifest.ts"],
    },
    {
        column: "identityManifestDigest",
        on: "RoutingAttempt",
        exempt: ["lib/routingIdentityManifest.ts"],
    },
    {
        column: "providerEndpointId",
        on: "ProviderProbeResult and RoutingAttempt",
        exempt: [
            "lib/availabilityObservation.ts",
            "lib/deploymentIdentity.ts",
            "lib/routingIdentityManifest.ts",
        ],
    },
    {
        column: "modelDeploymentId",
        on: "ProviderProbeResult and RoutingAttempt",
        exempt: [
            "lib/availabilityObservation.ts",
            "lib/deploymentCacheAffinity.ts",
            "lib/deploymentIdentity.ts",
            "lib/routingIdentityManifest.ts",
        ],
    },
];

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

        // `Type`, `Type[]` and `Type?` all reach the table. An earlier
        // version matched only the first two, so an optional relation was
        // invisible to this list.
        const field = /^\s+(\w+)\s+(\w+)(\[\]|\?)?\s*(@|$)/.exec(line);
        if (field && byTable[field[2]] && !byTable[field[2]].includes(field[1])) {
            byTable[field[2]].push(field[1]);
        }
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
    for (const entry of DARK_COLUMNS) {
        if (entry.exempt.includes(normalised)) continue;
        if (new RegExp(`\\b${entry.column}\\b`).test(source)) {
            problems.push(`${normalised}: names ${entry.on}.${entry.column}`);
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
