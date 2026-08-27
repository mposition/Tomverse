/**
 * The inspect workflow reads a run that already happened.
 *
 * Its whole value is that it cannot spend: reading an artifact should not cost
 * what producing one did, and a reading workflow that could call a provider
 * would need the same typed confirmation and the same budget arithmetic as the
 * run itself. So the tests below are mostly about what is absent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
    new URL(
        "../.github/workflows/memory-eval-inspect-artifact.yml",
        import.meta.url
    ),
    "utf8"
);

test("it cannot spend", () => {
    // No key, no live flag, no eval harness invocation. Each of these is how
    // a provider call gets into a job, and none of them is here.
    for (const forbidden of [
        "OPENAI_API_KEY",
        "--live",
        "eval:memory-extraction",
        "max-cost-usd",
    ]) {
        assert.ok(
            !workflow.includes(forbidden),
            `${forbidden} would make this able to spend, and it is meant not to be`
        );
    }
});

test("it runs only on manual dispatch", () => {
    const triggers = workflow.slice(
        workflow.indexOf("\non:"),
        workflow.indexOf("\npermissions:")
    );
    assert.match(triggers, /workflow_dispatch:/);
    for (const forbidden of ["push:", "pull_request:", "schedule:"]) {
        assert.ok(!triggers.includes(forbidden), `${forbidden} is not wanted`);
    }
});

test("a branch without the scripts says which branch to pick", () => {
    // The file lives on `main` so GitHub will offer it, while the scripts it
    // calls live on `develop`. The default ref is therefore the one that
    // cannot run it, and "Missing script" says nothing about that. Free to get
    // wrong, unlike the decision-grade run, and for that reason more likely to
    // be dispatched casually from whichever branch the UI offers first.
    assert.match(workflow, /Re-dispatch with Branch: develop/);
    for (const script of [
        "report:memory-eval-failures",
        "check:memory-eval-run",
        "make:memory-eval-blind-review",
    ]) {
        assert.ok(
            workflow.includes(`"${script}"`),
            `the guard should name ${script}`
        );
    }
    // Before the download, so a branch that cannot read the artifact does not
    // fetch it first.
    assert.ok(
        workflow.indexOf("The selected ref can run this") <
            workflow.indexOf("name: Download the artifact")
    );
});

test("it reaches other runs read-only", () => {
    // `actions: read` is the only extra permission downloading another run's
    // artifact needs. `contents: write` would let a reading job edit its own
    // subject.
    const permissions = workflow.slice(
        workflow.indexOf("\npermissions:"),
        workflow.indexOf("\njobs:")
    );
    assert.match(permissions, /contents: read/);
    assert.match(permissions, /actions: read/);
    assert.ok(!permissions.includes("write"));
    assert.match(workflow, /run-id: \$\{\{ inputs\.run_id \}\}/);
});

test("it names the file it read instead of assuming one", () => {
    // The JSON is named from the run's `run_label` and the artifact from its
    // `name`; nothing enforces that those agree.
    assert.match(workflow, /-name '\*\.json'/);
    assert.match(workflow, /Expected exactly one \.json/);
    assert.match(workflow, /ARTIFACT=\$artifact/);
});

test("the steps that need a file check they have one", () => {
    for (const step of ["Admissibility", "Blind review sheet"]) {
        const at = workflow.indexOf(`name: ${step}`);
        assert.ok(at > 0, `${step} step missing`);
        assert.match(
            workflow.slice(at, at + 220),
            /if: always\(\) && env\.ARTIFACT != ''/,
            `${step} should survive an earlier red step but not run without a file`
        );
    }
});

test("inputs reach the commands through the environment", () => {
    // Same rule the decision-grade workflow states: an input that lands inside
    // the command is an input that can end it.
    const at = workflow.indexOf("name: Which cases failed");
    const step = workflow.slice(at, workflow.indexOf("name: Admissibility"));
    assert.match(step, /MAX_ROWS: \$\{\{ inputs\.max_rows \}\}/);
    assert.ok(!/run: \|[\s\S]*\$\{\{ inputs\./.test(step));
});
