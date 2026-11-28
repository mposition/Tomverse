import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CATEGORIES, loadTasks, selectTasks, validateTask } from "../lib/tasks.mjs";
import { tempDir } from "./helpers.mjs";

const tasks = loadTasks();

const filesUnder = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(full) : [full];
    });

test("there are 30 tasks with a balanced mix of categories", () => {
    assert.equal(tasks.length, 30);
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, tasks.filter((t) => t.category === c).length]));
    for (const [category, count] of Object.entries(counts)) assert.ok(count >= 5, `${category} has only ${count} tasks`);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 30);
});

test("task ids are unique and every task is valid", () => {
    assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
    for (const task of tasks) assert.deepEqual(validateTask(task, task.id), [], task.id);
});

test("every task repo is a small project of 3 to 10 files without hidden material", () => {
    for (const task of tasks) {
        const files = filesUnder(join(task.dir, "repo"));
        assert.ok(files.length >= 3 && files.length <= 10, `${task.id} has ${files.length} files`);
        for (const file of files) {
            assert.ok(!/__check__|mutants/.test(file), `${task.id}: ${file}`);
            assert.ok(!/node_modules/.test(file), file);
        }
        const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
        assert.ok(!text.includes("__check__"), `${task.id} repo mentions the hidden check folder`);
    }
});

test("the agent prompt never reveals hidden test content", () => {
    for (const task of tasks) {
        assert.ok(!task.prompt.includes("__check__"), task.id);
        assert.ok(task.prompt.length > 150, `${task.id} prompt is too short to be a real task`);
        assert.ok(task.prompt.includes("npm test"), `${task.id} should say how to run the visible tests`);
    }
});

test("test-writing tasks ship pristine files and mutants in check/, nothing in repo/test", () => {
    for (const task of tasks.filter((t) => t.category === "test-writing")) {
        assert.deepEqual(task.check, ["node", "__check__/check.mjs"], task.id);
        assert.ok(existsSync(join(task.dir, "check", "correct")), task.id);
        const mutants = readdirSync(join(task.dir, "check", "mutants"));
        assert.ok(mutants.length >= 7, `${task.id} has only ${mutants.length} defective implementations`);
        const testFiles = existsSync(join(task.dir, "repo", "test")) ? readdirSync(join(task.dir, "repo", "test")).filter((f) => f.endsWith(".test.mjs")) : [];
        assert.deepEqual(testFiles, [], `${task.id} must not ship tests`);
        assert.ok(existsSync(join(task.dir, "solution", "test")), task.id);
    }
});

test("the other categories judge with hidden node:test files", () => {
    for (const task of tasks.filter((t) => t.category !== "test-writing")) {
        assert.deepEqual(task.check, ["node", "--test", "__check__/*.test.mjs"], task.id);
        const hidden = readdirSync(join(task.dir, "check")).filter((f) => f.endsWith(".test.mjs"));
        assert.ok(hidden.length >= 1, task.id);
    }
});

test("visible tests are green before and after the solution is applied", () => {
    const sandbox = tempDir();
    try {
        for (const task of tasks) {
            const testDir = join(task.dir, "repo", "test");
            if (!existsSync(testDir) || !statSync(testDir).isDirectory() || !readdirSync(testDir).some((f) => f.endsWith(".test.mjs"))) continue;
            for (const stage of ["initial", "solved"]) {
                const work = join(sandbox.dir, `${task.id}-${stage}`);
                cpSync(join(task.dir, "repo"), work, { recursive: true });
                if (stage === "solved") cpSync(join(task.dir, "solution"), work, { recursive: true, force: true });
                const result = spawnSync(process.execPath, ["--test"], { cwd: work, encoding: "utf8" });
                assert.equal(result.status, 0, `${task.id} (${stage}) visible tests fail:\n${result.stdout.split("\n").slice(-25).join("\n")}`);
            }
        }
    } finally {
        sandbox.dispose();
    }
});

test("selectTasks filters and rejects unknown names", () => {
    assert.equal(selectTasks(tasks, { categories: ["refactor"] }).length, 5);
    assert.deepEqual(selectTasks(tasks, { ids: ["bf-pagination", "rf-split-utils"] }).map((t) => t.id), ["bf-pagination", "rf-split-utils"]);
    assert.throws(() => selectTasks(tasks, { ids: ["nope"] }), /Unknown task "nope"/);
    assert.throws(() => selectTasks(tasks, { categories: ["nope"] }), /Unknown category/);
});

test("validateTask reports problems", () => {
    const problems = validateTask({ id: "X", category: "weird", title: "", prompt: "short", check: [], timeoutSeconds: 0 }, "other");
    assert.ok(problems.length >= 6);
});
