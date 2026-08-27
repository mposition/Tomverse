/**
 * The decision-grade run workflow spends money, so its guards are pinned.
 *
 * docs/ops/memory-extraction-decision-grade-run.md §2.5 explains why the run
 * belongs in CI rather than on a machine. That only holds while the workflow
 * keeps the four properties below; each one has already been the difference
 * between a citable run and a wasted budget somewhere in this programme.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** The guard's own needle, written once so the escaping is stated in one place. */
const HARNESS_LIMIT_GUARD = `harness.includes(${JSON.stringify('argValue("limit"')})`;

const workflow = readFileSync(
    new URL("../.github/workflows/memory-eval-decision-grade.yml", import.meta.url),
    "utf8"
);

test("it runs only on manual dispatch", () => {
    // A push trigger would spend the eval budget on every commit.
    const triggers = workflow.slice(
        workflow.indexOf("\non:"),
        workflow.indexOf("\npermissions:")
    );
    assert.match(triggers, /workflow_dispatch:/);
    for (const forbidden of ["push:", "pull_request:", "schedule:"]) {
        assert.ok(
            !triggers.includes(forbidden),
            `${forbidden} would spend the budget without anyone asking`
        );
    }
});

test("a dispatch has to be confirmed in words", () => {
    assert.match(workflow, /inputs\.confirm != 'SPEND'/);
    assert.match(workflow, /exit 1/);
});

test("the artifact is preserved even when a later step fails", () => {
    // A run that paid for 1,150 calls must not lose its records because the
    // admissibility check exited non-zero -- the records are what a re-reading
    // and the register entry are built from.
    const upload = workflow.indexOf("Preserve the artifact");
    const admissibility = workflow.indexOf("name: Admissibility");
    assert.ok(upload > 0 && admissibility > upload, "upload must come first");
    assert.match(
        workflow.slice(upload, admissibility),
        /if: always\(\)/,
        "the upload must not be skipped by an earlier failure"
    );
});

test("two runs cannot overlap, and neither is cancelled", () => {
    assert.match(workflow, /group: memory-eval-decision-grade/);
    // Cancelling mid-run abandons calls already paid for.
    assert.match(workflow, /cancel-in-progress: false/);
});

test("a probe skips the steps that would judge it as a run", () => {
    // A probe's `decisionGrade` is false by construction, so the admissibility
    // rules would discard it every time -- a red job saying "may not be cited"
    // about something that was never a candidate for citation. The blind
    // review sheet samples every cell and a probe reaches few of them.
    for (const step of [
        "Which cases failed",
        "Admissibility",
        "Blind review sheet",
    ]) {
        const at = workflow.indexOf(`name: ${step}`);
        assert.ok(at > 0, `${step} step missing`);
        assert.match(
            workflow.slice(at, at + 200),
            /if: always\(\) && inputs\.limit == ''/,
            `${step} should not run on a probe`
        );
    }
});

test("a failing verdict still gets diagnosed", () => {
    // The harness reports the judgement of
    // docs/policy/external-conversation-import-and-memory.md §12.3 through its
    // exit status, so a not-a-pass leaves the live step red -- a result, not
    // an error. Admissibility asks a different question, may this run be
    // cited, and none of the signals it reads is the verdict, so a failing
    // run can be perfectly admissible. Without `always()` the two steps that
    // read a failing run were the two steps a failing run skipped: run1 on
    // 2026-08-26 measured all 1,150 cases, missed the critical bulk-safe gate
    // 49 times, and produced neither an admissibility verdict nor a sheet to
    // read the answers with.
    for (const step of [
        "Which cases failed",
        "Admissibility",
        "Blind review sheet",
    ]) {
        const at = workflow.indexOf(`name: ${step}`);
        assert.match(
            workflow.slice(at, at + 200),
            /if: always\(\)/,
            `${step} must survive a red live step`
        );
    }
    const report = workflow.indexOf("name: Which cases failed");
    const admissibility = workflow.indexOf("name: Admissibility");
    const sheet = workflow.indexOf("name: Blind review sheet");
    const preserve = workflow.indexOf("name: Preserve the blind review sheet");
    for (const [name, step] of [
        ["Which cases failed", workflow.slice(report, admissibility)],
        ["Admissibility", workflow.slice(admissibility, sheet)],
        ["Blind review sheet", workflow.slice(sheet, preserve)],
    ]) {
        // A run that died before writing its artifact already has an error of
        // its own; ENOENT on top of it names neither the cause nor the remedy.
        assert.match(
            step,
            /if \[ ! -f "\$artifact" \]/,
            `${name} should say so rather than fail on a missing artifact`
        );
        // Same rule as the limit: an input interpolated into a shell line is
        // an input that can end it.
        assert.match(step, /RUN_LABEL: \$\{\{ inputs\.run_label \}\}/);
        assert.ok(
            !/run: \|[\s\S]*\$\{\{ inputs\./.test(step),
            `${name} should read its inputs through the environment`
        );
    }
});

test("a branch that would ignore --limit refuses the probe", () => {
    // The hazard this closes: a harness predating `--limit` drops the flag
    // silently, so a request for ten cases runs all 1,150 and bills for them.
    // An unknown flag is not a smaller run, it is a full one.
    assert.match(workflow, /does not support --limit/);
    // It decides by reading the harness for the flag's own parse site, so a
    // branch that merely mentions `--limit` in a comment does not pass.
    assert.match(workflow, /evalImportedMemoryExtraction\.mjs/);
    assert.ok(workflow.includes(HARNESS_LIMIT_GUARD));
});

test("the limit reaches the command through the environment", () => {
    // An input interpolated into a shell line is an input that can end it.
    assert.match(workflow, /LIMIT: \$\{\{ inputs\.limit \}\}/);
    assert.match(workflow, /\$\{LIMIT:\+--limit="\$LIMIT"\}/);
    // And the key that pays for the run is still in the same env block.
    const at = workflow.indexOf("name: Live run (this is the step that spends)");
    const step = workflow.slice(at, workflow.indexOf("run: |", at));
    assert.match(step, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
    assert.match(step, /LIMIT:/);
});

test("the free refusals run before the paid ones", () => {
    const preconditions = workflow.indexOf("name: Preconditions");
    const live = workflow.indexOf("name: Live run (this is the step that spends)");
    assert.ok(preconditions > 0 && live > preconditions);
    assert.match(
        workflow.slice(preconditions, live),
        /check:memory-eval-freeze/,
        "everything that can refuse for free should refuse before the key is used"
    );
});
