import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { DB_INTEGRATION_GROUPS } from "../scripts/db-integration-groups.mjs";
import {
    ALL_DB_JOBS,
    OPS_OBSERVER_PG16_JOB,
    POSTGRES16_JOB,
    dbIntegrationScope,
    suitesByJob,
} from "../scripts/db-integration-scope.mjs";
import { importClosure, reaches } from "../scripts/import-closure.mjs";

// Credit Finance DB Integration runs a lane only when a changed file is
// reached from one of its suites. See scripts/db-integration-scope.mjs.

const ROOT = resolve(import.meta.dirname, "..");
const scope = (...paths) => dbIntegrationScope(paths, ROOT).jobs;

test("the jobs are the lanes plus the two PostgreSQL 16 jobs", () => {
    assert.deepEqual(ALL_DB_JOBS, [...DB_INTEGRATION_GROUPS, POSTGRES16_JOB, OPS_OBSERVER_PG16_JOB]);
    const byJob = suitesByJob(ROOT);
    for (const job of ALL_DB_JOBS) assert.ok(byJob.get(job).length > 0, `${job} has suites`);
});

test("no input, the schema, package files and the lane machinery run every job", () => {
    assert.deepEqual(scope(), ALL_DB_JOBS);
    for (const path of [
        "prisma/schema.prisma",
        "prisma/migrations/20990101000000_x/migration.sql",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "scripts/run-db-integration-tests.mjs",
        "scripts/db-integration-groups.mjs",
        "scripts/db-integration-scope.mjs",
        "scripts/import-closure.mjs",
        ".github/workflows/credit-finance-db-integration.yml",
    ]) {
        assert.deepEqual(scope(path), ALL_DB_JOBS, path);
    }
});

test("a file nothing in the suites reaches runs no job", () => {
    assert.deepEqual(scope("docs/qa/review-parity-baseline.md"), []);
    assert.deepEqual(scope("tests/e2e/chat.spec.ts"), []);
    assert.deepEqual(scope("tests/rustVendorScope.test.mjs"), []);
    assert.deepEqual(scope("components/marketing/LaunchHomepage.module.css"), []);
});

test("a suite runs its own lane, and not every lane", () => {
    const byJob = suitesByJob(ROOT);
    for (const lane of DB_INTEGRATION_GROUPS) {
        const [suite] = byJob.get(lane);
        const jobs = scope(suite);
        assert.ok(jobs.includes(lane), `${suite} runs ${lane}`);
        // A lane whose suites list tests/integration/ reaches every suite as
        // a named file, so a suite may run a second lane -- never all of them.
        assert.ok(jobs.length < ALL_DB_JOBS.length, `${suite} runs ${jobs.join(", ")}`);
    }
});

test("a lib file runs the lanes whose suites import it", () => {
    const byJob = suitesByJob(ROOT);
    const financeClosure = importClosure(ROOT, byJob.get("finance"));
    // Something the finance suites reach that is not a suite itself.
    const reachedLib = [...financeClosure.files].find((file) => file.startsWith("lib/") && file.endsWith(".ts"));
    assert.ok(reachedLib, "the finance suites reach some lib file");
    assert.ok(scope(reachedLib).includes("finance"), reachedLib);
});

test("a lane runs for a change to anything its suites import, directly or not", () => {
    // Built in a scratch tree so the chain is known: suite -> helper -> lib.
    const root = mkdtempSync(join(tmpdir(), "db-scope-"));
    try {
        const write = (path, text) => {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        };
        write("tests/integration/credit-finance-a.db.test.ts", 'import { h } from "./helpers/h";\n');
        write("tests/integration/helpers/h.ts", 'export { x } from "@/lib/deep.js";\n');
        write("lib/deep.ts", 'const sql = "prisma/migrations/20990101000000_x/migration.sql";\n');
        write("prisma/migrations/20990101000000_x/migration.sql", "SELECT 1;\n");
        write("lib/unrelated.ts", "export const y = 1;\n");
        write("lib/readOnly.ts", 'import "@/lib/unrelated";\n');
        write("tests/integration/memory-a.db.test.ts", 'const source = readFileSync("lib/readOnly.ts", "utf8");\n');
        const closure = importClosure(root, ["tests/integration/credit-finance-a.db.test.ts"]);
        assert.ok(reaches(closure, "lib/deep.ts"), "followed through @/ and a .js specifier");
        assert.ok(reaches(closure, "prisma/migrations/20990101000000_x/migration.sql"), "a named file is reached");
        assert.ok(!reaches(closure, "lib/unrelated.ts"));
        // A file a test reads as text is reached, but not followed.
        const reader = importClosure(root, ["tests/integration/memory-a.db.test.ts"]);
        assert.ok(reaches(reader, "lib/readOnly.ts"));
        assert.ok(!reaches(reader, "lib/unrelated.ts"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the CLI prints the lanes and whether any runs", () => {
    const run = (input, ...args) =>
        spawnSync(process.execPath, ["scripts/db-integration-scope.mjs", ...args], {
            cwd: ROOT,
            input,
            encoding: "utf8",
            env: { ...process.env, GITHUB_OUTPUT: "" },
        }).stdout.trim().split("\n");
    assert.deepEqual(run("", "--all"), [`lanes=${JSON.stringify(ALL_DB_JOBS)}`, "any=true"]);
    assert.deepEqual(run("docs/qa/review-parity-baseline.md\n"), ["lanes=[]", "any=false"]);
    const [lanes, any] = run("tests/integration/credit-finance.db.test.ts\n");
    assert.ok(JSON.parse(lanes.slice("lanes=".length)).includes("finance"), lanes);
    assert.equal(any, "any=true");
});

const workflow = parse(
    readFileSync(resolve(ROOT, ".github", "workflows", "credit-finance-db-integration.yml"), "utf8")
);

test("the workflow decides once and every job that runs the suites follows it", () => {
    const scopeJob = workflow.jobs.scope;
    const decide = scopeJob.steps.find((step) => step.id === "scope");
    assert.match(decide.run, /node scripts\/db-integration-scope\.mjs --all/);
    // main is where the suite guards production: it always runs whole.
    assert.match(decide.run, /\[ "\$BASE_REF" = "main" \] && all/);
    assert.match(decide.run, /\[ "\$REF" = "refs\/heads\/main" \] && all/);
    assert.equal(scopeJob.outputs.lanes, "${{ steps.scope.outputs.lanes }}");

    const lanes = workflow.jobs["credit-finance-db"];
    assert.equal(lanes.needs, "scope");
    assert.match(lanes.if, /^needs\.scope\.outputs\.any == 'true' && /);
    for (const step of lanes.steps) {
        assert.equal(step.if, "contains(fromJSON(needs.scope.outputs.lanes), matrix.group)", step.name);
    }
    assert.match(workflow.jobs["ops-observer-pg16"].if, /'ops-observer-pg16'\)/);
    assert.match(workflow.jobs["credit-finance-db-postgres16"].if, /'postgres16'\)/);

    // The result job fails when the scope job does.
    const result = workflow.jobs["credit-finance-db-result"];
    assert.ok(result.needs.includes("scope"));
    assert.match(result.steps[0].run, /test "\$SCOPE_RESULT" = "success"/);
});
