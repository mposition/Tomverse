/**
 * Auto-merge is armed once, by the run that opens the pull request.
 *
 * The workflow used to run its arming step on every push to a `to-develop`
 * branch: it looked up whatever PR was open for the branch and called
 * `gh pr merge --auto` on it. Auto-merge is a switch a person can turn off, so
 * that made their decision last exactly until the next commit -- and nothing
 * said so. On 2026-09-05 #1256 was checked (auto-merge off), a commit was
 * pushed, this workflow turned it back on, and the pull request squash-merged
 * into develop as 0c7eb828 while its author was still working on it.
 *
 * Two halves are pinned here, because either one alone would have passed under
 * the old behaviour:
 *
 *   - the create step reports `created=true` only for a PR it opened itself,
 *     proven by running its actual shell against a stubbed `gh`; and
 *   - the arming step is reachable only through that output, and never looks a
 *     pull request up for itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { resolveBashCommand } from "./support/gitBash.mjs";

const WORKFLOW_PATH = new URL(
    "../.github/workflows/auto-pr-to-develop.yml",
    import.meta.url
);
const workflowText = readFileSync(WORKFLOW_PATH, "utf8");
const steps = parse(workflowText).jobs["auto-pr"].steps;

// Resolved rather than looked up. `spawnSync("bash")` on Windows finds
// System32's WSL launcher first unless the suite happens to have been
// started from a Git Bash session, and on a machine with no distribution
// installed that launcher fails talking about WSL -- three cases below then
// fail for a reason that has nothing to do with the workflow.
const bash = resolveBashCommand();
const noBash = bash
    ? false
    : "no usable bash: git's installation has no bin/bash.exe or usr/bin/bash.exe, and PATH offers only the WSL launcher";

// Looked up rather than asserted here: a workflow that has lost either step
// should fail the test that names the property it lost, not the module load.
const createStep = steps.find((step) => step.id === "create-pr");
const armStep = steps.find((step) => /auto-merge/i.test(step.name ?? ""));

test("the workflow still has the two steps this contract is about", () => {
    assert.ok(
        createStep,
        'no step with id "create-pr": the arming condition has nothing to read'
    );
    assert.ok(armStep, "no auto-merge step");
});

/**
 * `gh` as a shell function rather than a file on PATH: the script under test
 * calls it unqualified, and a function needs no chmod, no PATH juggling and no
 * shebang -- which keeps this test the same on Windows and on the runner.
 *
 * The stub carries the one piece of state that matters: whether an open pull
 * request exists for the branch. `gh pr create` writes the new number into it,
 * so the script's second `gh pr list` sees what a real one would.
 *
 * Every path handed to the shell is a bare filename, with the temporary
 * directory supplied as the child's working directory instead. An absolute
 * Windows path reaching `cat` or a redirect depends on which bash answers --
 * Git Bash converts `C:\\...` and another does not -- and that is a property
 * of the machine running the test, not of the workflow it is about.
 */
function runCreateStep({ openPrNumber = "", createFails = false } = {}) {
    assert.ok(createStep, 'no step with id "create-pr"');
    const dir = mkdtempSync(join(tmpdir(), "auto-pr-arming-"));
    try {
        const stateName = "open-pr";
        const callsName = "gh-calls";
        const outputName = "github-output";
        const statePath = join(dir, stateName);
        const callsPath = join(dir, callsName);
        const outputPath = join(dir, outputName);
        writeFileSync(statePath, openPrNumber ? `${openPrNumber}\n` : "");
        writeFileSync(callsPath, "");
        writeFileSync(outputPath, "");

        const prelude = [
            "gh() {",
            '  if [ "$1 $2" = "pr list" ]; then',
            '    cat "$STUB_STATE"',
            "    return 0",
            "  fi",
            '  if [ "$1 $2" = "pr create" ]; then',
            '    echo "create" >> "$STUB_CALLS"',
            '    if [ "$STUB_CREATE_FAILS" = "1" ]; then',
            '      echo "gh: pull request creation failed" >&2',
            "      return 1",
            "    fi",
            '    printf \'%s\n\' "$STUB_NEW_NUMBER" > "$STUB_STATE"',
            '    echo "https://example.invalid/pull/$STUB_NEW_NUMBER"',
            "    return 0",
            "  fi",
            '  echo "unexpected gh invocation: $*" >&2',
            "  return 99",
            "}",
            "",
        ].join("\n");

        const result = spawnSync(bash, ["-c", prelude + createStep.run], {
            cwd: dir,
            env: {
                ...process.env,
                BRANCH: "claude/to-develop/example",
                GITHUB_OUTPUT: outputName,
                STUB_STATE: stateName,
                STUB_CALLS: callsName,
                STUB_NEW_NUMBER: "4242",
                STUB_CREATE_FAILS: createFails ? "1" : "0",
            },
            encoding: "utf8",
        });

        const outputs = Object.fromEntries(
            readFileSync(outputPath, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                    const at = line.indexOf("=");
                    return [line.slice(0, at), line.slice(at + 1)];
                })
        );
        return {
            status: result.status,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            outputs,
            createCalls: readFileSync(callsPath, "utf8").split("\n").filter(Boolean)
                .length,
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("a push to a branch whose PR is already open arms nothing", { skip: noBash }, () => {
    // The regression. A human turned auto-merge off on PR #1256; this is the
    // next push. The step must report that it created nothing, and must not
    // open a second pull request either.
    const run = runCreateStep({ openPrNumber: "1256" });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(
        run.outputs.created,
        "false",
        "an already-open PR is not this run's creation"
    );
    assert.equal(run.createCalls, 0, "no second PR for the same branch");
    assert.match(run.stdout, /already open/);

    // And with `created=false`, the arming step's own condition excludes it.
    assert.equal(
        armStep.if,
        "steps.create-pr.outputs.created == 'true'",
        "the arming step must be gated on this run having created the PR"
    );
});

test("the run that opens the pull request reports the number it opened", {
    skip: noBash,
}, () => {
    const run = runCreateStep({ openPrNumber: "" });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.outputs.created, "true");
    assert.equal(run.outputs.number, "4242");
    assert.equal(run.createCalls, 1);
});

test("a failed creation is not reported as a creation", { skip: noBash }, () => {
    // Without an explicit check `gh pr create` could fail and the step still
    // fall through to its success path -- which would hand the arming step a
    // number belonging to some other pull request, or none at all.
    const run = runCreateStep({ openPrNumber: "", createFails: true });

    assert.notEqual(run.status, 0, "a failed creation must fail the step");
    assert.notEqual(run.outputs.created, "true");
});

test("the arming step is handed a number and never looks one up", () => {
    // A `gh pr list` here would reintroduce the defect by another route: the
    // step would find the branch's existing PR regardless of what the create
    // step decided.
    assert.ok(armStep, "the workflow must still have an arming step");
    assert.ok(
        !/gh pr list/.test(armStep.run),
        "the arming step must not search for a pull request of its own"
    );
    assert.match(armStep.run, /"\$PR_NUMBER"/);
    assert.equal(
        armStep.env?.PR_NUMBER,
        "${{ steps.create-pr.outputs.number }}",
        "the number must come from the step that created the PR"
    );
});

test("the System32 launcher never wins, however early it sits on PATH", () => {
    // The regression this guards is silent in the worst way: WSL's launcher
    // is also called bash.exe, it is first on PATH in every Windows shell
    // except Git Bash, and what it reports is its own absence of a
    // distribution -- so the three cases above would fail with a message
    // about installing Linux while the workflow they check was fine.
    const system32 = "C:\\Windows\\System32";
    const windowsApps = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps";
    const gitBin = "C:\\Program Files\\Git\\usr\\bin";

    const hostilePath = [system32, windowsApps, gitBin].join(";");
    const resolved = resolveBashCommand({
        platform: "win32",
        env: { PATH: hostilePath },
        // git cannot answer, so PATH is all there is -- the case where the
        // exclusion by name is the only thing doing the work.
        gitExecPath: () => null,
        isFile: () => true,
    });

    assert.equal(resolved, `${gitBin}\\bash.exe`);
});

test("git's own installation is preferred over anything on PATH", () => {
    const resolved = resolveBashCommand({
        platform: "win32",
        env: { PATH: "C:\\Windows\\System32" },
        gitExecPath: () => "C:\\Program Files\\Git\\mingw64\\libexec\\git-core",
        isFile: (candidate) => candidate === "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    assert.equal(resolved, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("no usable interpreter is null, not a launcher that cannot run the script", () => {
    // Reported as a skip by the caller. Returning the launcher instead would
    // turn a missing tool into three failures blaming the workflow.
    const resolved = resolveBashCommand({
        platform: "win32",
        env: { PATH: "C:\\Windows\\System32" },
        gitExecPath: () => null,
        isFile: () => true,
    });

    assert.equal(resolved, null);
});

test("everywhere but Windows the PATH lookup is the right answer", () => {
    for (const platform of ["linux", "darwin"]) {
        assert.equal(
            resolveBashCommand({
                platform,
                env: { PATH: "/usr/bin" },
                gitExecPath: () => {
                    throw new Error("git must not be consulted off Windows");
                },
            }),
            "bash",
            platform
        );
    }
});

test("nothing else in the workflow can enable auto-merge", () => {
    const armingCalls = steps.filter(
        (step) => typeof step.run === "string" && /--auto\b/.test(step.run)
    );
    assert.deepEqual(
        armingCalls.map((step) => step.name),
        [armStep.name],
        "auto-merge is enabled in exactly one step"
    );
});
