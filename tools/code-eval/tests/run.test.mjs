import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUN, runNode, tempDir } from "./helpers.mjs";

const sandbox = tempDir();
let fake;
let noop;

before(() => {
    fake = { out: join(sandbox.dir, "fake"), ...runNode([RUN, "--route", "fake", "--concurrency", "6", "--out", join(sandbox.dir, "fake")]) };
    noop = { out: join(sandbox.dir, "noop"), ...runNode([RUN, "--route", "noop", "--concurrency", "6", "--out", join(sandbox.dir, "noop")]) };
});
after(() => sandbox.dispose());

const results = (run) => JSON.parse(readFileSync(join(run.out, "results.json"), "utf8"));

test("the fake route solves all 30 tasks", () => {
    assert.equal(fake.status, 0, fake.stderr);
    const data = results(fake);
    assert.equal(data.results.length, 30);
    assert.equal(data.results.filter((r) => r.passed).length, 30);
    assert.match(fake.stdout, /fake: 30\/30 passed \(100\.0%\)/);
});

test("the noop route fails all 30 tasks", () => {
    assert.equal(noop.status, 0, noop.stderr);
    const data = results(noop);
    assert.equal(data.results.length, 30);
    assert.equal(data.results.filter((r) => r.passed).length, 0);
    assert.match(noop.stdout, /noop: 0\/30 passed \(0\.0%\)/);
});

test("result records carry what a comparison needs", () => {
    const record = results(fake).results.find((r) => r.taskId === "rf-split-utils");
    assert.equal(record.route, "fake");
    assert.equal(record.category, "refactor");
    assert.equal(record.adapterStatus, "ok");
    assert.equal(record.checkExit, 0);
    assert.ok(record.changedFiles >= 4, `changed files: ${record.changedFiles}`);
    for (const key of ["agentMs", "checkMs", "totalMs"]) assert.equal(typeof record[key], "number", key);
    const noopRecord = results(noop).results.find((r) => r.taskId === "rf-split-utils");
    assert.equal(noopRecord.changedFiles, 0);
    assert.ok(noopRecord.checkOutputTail.length > 0, "a failed check keeps the tail of its output");
});

test("summary.md has the documented tables", () => {
    const text = readFileSync(join(fake.out, "summary.md"), "utf8");
    for (const heading of ["# Code eval summary", "## Success rate by route", "## Success rate by category", "## Time and cost", "## Per-task results"]) {
        assert.ok(text.includes(heading), heading);
    }
    assert.match(text, /\| fake \| 30\/30 \| 100\.0% \| 0 \|/);
    assert.match(text, /\| bugfix \| 7\/7 \(100\.0%\) \|/);
    assert.match(text, /\| test-writing \| 5\/5 \(100\.0%\) \|/);
    const rows = text.split("\n").filter((line) => /^\| [a-z]{2}-[a-z0-9-]+ \| [a-z-]+ \| PASS \|$/.test(line));
    assert.equal(rows.length, 30);
});

test("working folders are removed after the run", () => {
    assert.ok(results(fake).results.every((r) => r.workDir === undefined));
});

test("--task, --category and --list", () => {
    const out = join(sandbox.dir, "subset");
    const run = runNode([RUN, "--route", "fake", "--task", "bf-pagination", "--task", "tw-slugify", "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(results({ out }).results.map((r) => r.taskId).sort(), ["bf-pagination", "tw-slugify"]);
    const byCategory = runNode([RUN, "--route", "noop", "--category", "test-writing", "--out", join(sandbox.dir, "cat")]);
    assert.match(byCategory.stdout, /noop: 0\/5 passed/);
    const listing = runNode([RUN, "--list"]);
    assert.equal(listing.stdout.trim().split("\n").length, 30);
});

test("--keep-workdirs keeps the folder and its path is recorded", () => {
    const out = join(sandbox.dir, "kept");
    const run = runNode([RUN, "--route", "noop", "--task", "bf-pagination", "--keep-workdirs", "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    const [record] = results({ out }).results;
    assert.ok(existsSync(join(record.workDir, ".git")), "the folder is a git repository");
    assert.ok(existsSync(join(record.workDir, "__check__")), "the hidden check was installed after the agent ran");
});

test("real routes are refused without --allow-paid, before anything is created", () => {
    for (const route of ["tomverse", "codex", "claude"]) {
        const out = join(sandbox.dir, `refused-${route}`);
        const run = runNode([RUN, "--route", route, "--out", out], { env: { TOMVERSE_API_KEY: "tvk_aaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
        assert.equal(run.status, 2, `${route}: ${run.stderr}`);
        assert.match(run.stderr, /Refusing to run/, route);
        assert.match(run.stderr, /--allow-paid/, route);
        assert.match(run.stderr, new RegExp(`route ${route}`), route);
        assert.equal(run.stdout.trim(), "", `${route} printed results`);
        assert.equal(existsSync(out), false, `${route} created its output folder`);
    }
});

test("a paid route mixed with fake is refused as a whole", () => {
    const out = join(sandbox.dir, "mixed");
    const run = runNode([RUN, "--route", "fake,codex", "--out", out]);
    assert.equal(run.status, 2);
    assert.equal(existsSync(out), false);
});

test("with --allow-paid the tomverse route still needs the API key from the environment", () => {
    const run = runNode([RUN, "--route", "tomverse", "--allow-paid", "--out", join(sandbox.dir, "nokey")]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /TOMVERSE_API_KEY is not set/);
    assert.ok(!/--api-key/.test(readFileSync(RUN, "utf8")), "there is no key flag");
});

test("usage errors exit with 2", () => {
    assert.equal(runNode([RUN]).status, 2);
    assert.equal(runNode([RUN, "--route", "bogus"]).status, 2);
    assert.equal(runNode([RUN, "--route", "fake", "--task", "bogus"]).status, 2);
    assert.equal(runNode([RUN, "--route", "fake", "--concurrency", "0"]).status, 2);
    assert.equal(runNode([RUN, "--wat"]).status, 2);
    assert.equal(runNode([RUN, "--help"]).status, 0);
});
