import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMutationCheck } from "../lib/mutation-check.mjs";
import { tempDir } from "./helpers.mjs";

const CORRECT = "export const add = (a, b) => a + b;\n";
const MUTANTS = {
    "subtracts": "export const add = (a, b) => a - b;\n",
    "ignores-b": "export const add = (a) => a;\n",
    "negates": "export const add = (a, b) => -(a + b) || 0;\n",
};

const project = (testSource) => {
    const sandbox = tempDir();
    const put = (rel, text) => {
        const file = join(sandbox.dir, rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
    };
    put("src/add.js", CORRECT);
    put("package.json", '{"type":"module"}');
    put("__check__/correct/src/add.js", CORRECT);
    for (const [name, text] of Object.entries(MUTANTS)) put(`__check__/mutants/${name}/src/add.js`, text);
    if (testSource) put("test/add.test.mjs", testSource);
    return sandbox;
};

const quiet = (fn) => {
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
        return fn();
    } finally {
        console.log = log;
        console.error = error;
    }
};

// The passing suite is a tracked file, copied into each sandbox as test/add.test.mjs: its relative import then resolves to
// a file of this repository, which the control-plane analysis (tests/agentControlPlaneSlice.test.mjs) needs to follow it.
const good = readFileSync(new URL("./fixtures/mutation/test/add-suite.mjs", import.meta.url), "utf8");

test("tests that kill every defective implementation pass", () => {
    const sandbox = project(good);
    try {
        const report = quiet(() => runMutationCheck({ workDir: sandbox.dir, minTests: 4 }));
        assert.equal(report.ok, true, JSON.stringify(report));
        assert.equal(report.mutants, 3);
    } finally {
        sandbox.dispose();
    }
});

test("no test file is a failure", () => {
    const sandbox = project(null);
    try {
        const report = quiet(() => runMutationCheck({ workDir: sandbox.dir }));
        assert.equal(report.ok, false);
        assert.match(report.problems[0], /no test/);
    } finally {
        sandbox.dispose();
    }
});

test("a test file with no tests in it is a failure", () => {
    const sandbox = project('import "node:test";\n');
    try {
        const report = quiet(() => runMutationCheck({ workDir: sandbox.dir, minTests: 4 }));
        assert.equal(report.ok, false);
        assert.match(report.problems[0], /only \d+ passing tests; at least 4/);
    } finally {
        sandbox.dispose();
    }
});

test("tests that fail on the correct implementation are a failure", () => {
    const sandbox = project(good.replace("add(2, 3), 5", "add(2, 3), 6"));
    try {
        const report = quiet(() => runMutationCheck({ workDir: sandbox.dir, minTests: 4 }));
        assert.equal(report.ok, false);
        assert.match(report.problems[0], /fail against the correct implementation/);
    } finally {
        sandbox.dispose();
    }
});

test("weak tests let defective implementations survive and are named", () => {
    const weak = good.replaceAll("add(2, 3), 5", "add(0, 0), 0").replace("add(-2, -3), -5", "add(0, 0), 0").replace("add(10, -4), 6", "add(0, 0), 0");
    const sandbox = project(weak);
    try {
        const report = quiet(() => runMutationCheck({ workDir: sandbox.dir, minTests: 4 }));
        assert.equal(report.ok, false);
        assert.deepEqual(report.survived.sort(), ["ignores-b", "negates", "subtracts"].sort());
    } finally {
        sandbox.dispose();
    }
});

test("the agent cannot win by editing src: the pristine file is restored", () => {
    const sandbox = project(good);
    try {
        writeFileSync(join(sandbox.dir, "src", "add.js"), "export const add = (a, b) => 5;\n");
        const report = quiet(() => runMutationCheck({ workDir: sandbox.dir, minTests: 4 }));
        assert.equal(report.ok, true, JSON.stringify(report));
    } finally {
        sandbox.dispose();
    }
});
