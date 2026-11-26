// Judge for "write tests" tasks. Copied next to the hidden tests as
// __check__/mutation-check.mjs; the working folder is the current directory.
//
// The agent's tests (test/*.test.mjs) must pass against the pristine
// implementation and must fail against every prepared defective one.
//
// A task's check/ folder holds:
//   correct/<path>        pristine files, restored before the "correct" run
//   mutants/<name>/<path> files overlaid for one defective variant
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

// A parent `node --test` marks its children; a nested test run must not look like one of them.
const cleanEnv = () => {
    const env = { ...process.env, NODE_OPTIONS: "" };
    delete env.NODE_TEST_CONTEXT;
    return env;
};

const SKIP = new Set(["__check__", ".git", "node_modules"]);
const TEST_PATTERN = "test/**/*.test.mjs";

const listFiles = (dir, base = dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? listFiles(full, base) : [relative(base, full)];
    });

const runTests = (cwd) => {
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", TEST_PATTERN], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: cleanEnv(),
    });
    const count = (name) => Number(new RegExp("^# " + name + " ([0-9]+)", "m").exec(result.stdout)?.[1] ?? 0);
    return {
        status: result.status,
        timedOut: result.error?.code === "ETIMEDOUT",
        tests: count("tests"),
        pass: count("pass"),
        fail: count("fail"),
        tail: `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-12).join("\n"),
    };
};

const variant = (workDir, checkDir, overlayDir) => {
    const scratch = mkdtempSync(join(tmpdir(), "code-eval-mut-"));
    cpSync(workDir, scratch, { recursive: true, filter: (src) => !SKIP.has(relative(workDir, src).split(/[\/]/)[0]) });
    if (existsSync(overlayDir)) cpSync(overlayDir, scratch, { recursive: true, force: true });
    return scratch;
};

export const runMutationCheck = ({ workDir = process.cwd(), checkDir = join(workDir, "__check__"), minTests = 3 } = {}) => {
    const problems = [];
    const testsDir = join(workDir, "test");
    const testFiles = existsSync(testsDir) && statSync(testsDir).isDirectory() ? listFiles(testsDir).filter((f) => f.endsWith(".test.mjs")) : [];
    if (!testFiles.length) problems.push("no test/*.test.mjs file was written");

    if (!problems.length) {
        const scratch = variant(workDir, checkDir, join(checkDir, "correct"));
        try {
            const correct = runTests(scratch);
            if (correct.status !== 0 || correct.timedOut) problems.push(`tests fail against the correct implementation\n${correct.tail}`);
            else if (correct.pass < minTests) problems.push(`only ${correct.pass} passing tests; at least ${minTests} are expected`);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }

    const mutantsDir = join(checkDir, "mutants");
    const names = readdirSync(mutantsDir).filter((name) => statSync(join(mutantsDir, name)).isDirectory()).sort();
    const survived = [];
    if (!problems.length) {
        for (const name of names) {
            // The pristine files go in first so only this mutant's files differ.
            const scratch = variant(workDir, checkDir, join(checkDir, "correct"));
            try {
                cpSync(join(mutantsDir, name), scratch, { recursive: true, force: true });
                const result = runTests(scratch);
                if (result.status === 0 && !result.timedOut) survived.push(name);
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        }
        if (survived.length) problems.push(`the tests did not catch ${survived.length} of ${names.length} defective implementations: ${survived.join(", ")}`);
    }

    const report = { ok: problems.length === 0, mutants: names.length, survived, problems };
    console.log(JSON.stringify(report));
    if (problems.length) console.error(problems.join("\n"));
    return report;
};
