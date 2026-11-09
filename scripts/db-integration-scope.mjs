// Which database integration lanes can a change reach?
//
//   git diff --no-renames --name-only <base> HEAD | node scripts/db-integration-scope.mjs
//   node scripts/db-integration-scope.mjs --all
//
// Prints `lanes=<JSON array>` and `any=true|false` (appended to
// $GITHUB_OUTPUT when set) and says why on stderr. Credit Finance DB
// Integration's scope job reads it; a lane outside the list starts its job and
// skips the install and the suites.
//
// ## Why (2026-11-09, before the repository goes private)
//
// This workflow was ~26% of all Actions minutes: twelve lanes and two
// PostgreSQL 16 jobs, ~87 runner-minutes a run, on every develop push and on
// every pull request that touched one of ~60 path prefixes. The prefixes were
// widened on purpose (see the workflow) because a hand-kept list drifted, and
// wide prefixes meant a one-line change to lib/emailPolicyPublication.ts ran
// the AMUX, memory and routing lanes too.
//
// The comment there names the list that would not drift: "one derived from
// what the suite imports". This is that list. A lane runs when a changed file
// is reached from one of its suites (scripts/import-closure.mjs), so a new
// import is covered the day it is written and an unrelated lane stays idle.
//
// ## Everything runs when
//
// - there is no usable diff (no paths, `--all`);
// - a changed path is under prisma/ (every lane builds its schema from it), a
//   package file, tsconfig, this script, the closure script, the lane rules or
//   the workflow;
// - a changed path is reached by the runner itself, apart from the suites it
//   names (scripts/run-db-integration-tests.mjs and everything it imports);
//
// A deleted file decides nothing by itself: a suite that still imported it
// would not compile, and the file that stopped importing it is in the diff
// too, where its own lanes pick it up.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
    DB_INTEGRATION_GROUPS,
    POSTGRES16_COMPAT_SUITES,
    dbIntegrationGroupOf,
} from "./db-integration-groups.mjs";
import { changedPathsFrom, importClosure, reaches } from "./import-closure.mjs";

/** Not lanes: the two PostgreSQL 16 jobs, decided the same way. */
export const POSTGRES16_JOB = "postgres16";
export const OPS_OBSERVER_PG16_JOB = "ops-observer-pg16";
export const OPS_OBSERVER_PG16_SUITE = "tests/integration/ops-observer-transaction-bounds.db.test.ts";
export const ALL_DB_JOBS = Object.freeze([...DB_INTEGRATION_GROUPS, POSTGRES16_JOB, OPS_OBSERVER_PG16_JOB]);

const RUNNER = "scripts/run-db-integration-tests.mjs";
const SUITE = /^tests\/integration\/[^/]+\.db\.test\.(?:ts|mjs)$/;

const RUN_ALL = [
    /^prisma\//,
    /^package(-lock)?\.json$/,
    /^tsconfig(\.[^/]+)?\.json$/,
    /^\.nvmrc$/,
    /^scripts\/(db-integration-scope|db-integration-groups|import-closure)\.mjs$/,
    /^\.github\/workflows\/credit-finance-db-integration\.yml$/,
];

export const suitesOnDisk = (root) =>
    readdirSync(join(root, "tests", "integration"))
        .filter((name) => /\.db\.test\.(?:ts|mjs)$/.test(name))
        .map((name) => `tests/integration/${name}`)
        .sort();

/** The suites each job runs. */
export const suitesByJob = (root) => {
    const byJob = new Map(ALL_DB_JOBS.map((job) => [job, []]));
    for (const suite of suitesOnDisk(root)) byJob.get(dbIntegrationGroupOf(suite)).push(suite);
    byJob.set(POSTGRES16_JOB, [...POSTGRES16_COMPAT_SUITES]);
    byJob.set(OPS_OBSERVER_PG16_JOB, [OPS_OBSERVER_PG16_SUITE]);
    return byJob;
};

export const dbIntegrationScope = (changedPaths, root = process.cwd()) => {
    const paths = changedPaths.filter((path) => path !== "");
    const all = (reason) => ({ jobs: [...ALL_DB_JOBS], reason });
    if (paths.length === 0) return all("no changed paths were given, so every lane runs");

    const runAll = paths.find((path) => RUN_ALL.some((pattern) => pattern.test(path)));
    if (runAll) return all(`${runAll} is read by every lane`);

    // The suites the runner names are lanes' business, not the runner's.
    const runner = importClosure(root, [RUNNER], { skip: (file) => SUITE.test(file) });
    const reachedByRunner = paths.find((path) => reaches(runner, path));
    if (reachedByRunner) return all(`${reachedByRunner} is reached by the runner itself`);

    const jobs = [];
    const why = [];
    for (const [job, suites] of suitesByJob(root)) {
        const closure = importClosure(root, suites);
        const hit = paths.find((path) => reaches(closure, path));
        if (hit) {
            jobs.push(job);
            why.push(`${job} (${hit})`);
        }
    }
    return {
        jobs,
        reason: jobs.length === 0 ? `none of the ${paths.length} changed path(s) is reached by a suite` : `reached: ${why.join(", ")}`,
    };
};

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { appendFileSync } = await import("node:fs");
    const input = process.argv.includes("--all") ? "" : readFileSync(0, "utf8");
    let result;
    try {
        result = dbIntegrationScope(changedPathsFrom(input));
    } catch (error) {
        result = { jobs: [...ALL_DB_JOBS], reason: `the scope could not be computed (${error.message}), so every lane runs` };
    }
    const lines = [`lanes=${JSON.stringify(result.jobs)}`, `any=${result.jobs.length > 0}`];
    console.error(`database lanes: ${result.jobs.length}/${ALL_DB_JOBS.length} -- ${result.reason}.`);
    console.log(lines.join("\n"));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
