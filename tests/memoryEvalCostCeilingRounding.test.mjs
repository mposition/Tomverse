import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

/**
 * A ceiling that rounds to nearest is not a ceiling.
 *
 * `report:memory-eval-cost-estimate` exists to hand somebody a figure to write
 * into `evalBudget.maxUsd`, and it formatted every figure with `toFixed(2)` —
 * which rounds down about half the time. On `mem-eval-succ-9` the raw per-run
 * worst case is US$6.4928602 and that display read `US$6.49`: a fifth of a cent
 * *below* the worst case it bounds. A run that hit the output cap would have
 * been stopped by its own approved ceiling, and a run stopped by its ceiling is
 * truncated rather than decision-grade — the one outcome the ceiling is set
 * from the worst case to avoid.
 *
 * It had not cost anything yet only because the figure being transcribed was
 * the two-run total, where 12.9857204 happens to round up. Luck of the value,
 * not a property of the formatter.
 *
 * So this parses the numbers the report tells an approver to use and asserts
 * they bound the raw worst case it prints beside them. Run as the command,
 * because the defect was in what the command *printed*: every internal value
 * was correct.
 */

const invoke = (args = []) =>
    spawnSync(
        process.execPath,
        [
            "--conditions=react-server",
            "--import",
            "tsx",
            "scripts/report-memory-eval-cost-estimate.mjs",
            ...args,
        ],
        { cwd: new URL("..", import.meta.url), encoding: "utf8" }
    );

/**
 * The output, and only after the command is known to have succeeded.
 *
 * The first version of this file read `.stdout` and threw the rest away, so a
 * command that printed a correct-looking report and then exited non-zero — or
 * printed nothing at all and failed — passed every assertion below, because a
 * regex that finds nothing in an empty string is the only thing that would have
 * complained, and these look for numbers that were already there.
 */
const run = (args = []) => {
    const result = invoke(args);
    assert.equal(
        result.status,
        0,
        `the report exited ${result.status}:\n${result.stdout}${result.stderr}`
    );
    assert.equal(result.stderr, "", `the report wrote to stderr:\n${result.stderr}`);
    return result.stdout;
};

const numberAfter = (output, label) => {
    const row = output
        .split("\n")
        .find((line) => line.startsWith(label));
    assert.ok(row, `the report has no "${label}" row:\n${output}`);
    return row.slice(label.length);
};

test("the approvable ceilings bound the raw worst case they are printed beside", () => {
    const output = run();

    const raw = numberAfter(output, "raw worst case, per run / all runs")
        .trim()
        .split("/")
        .map((part) => Number(part.trim()));
    assert.equal(raw.length, 2, output);
    for (const value of raw) assert.ok(Number.isFinite(value) && value > 0, output);
    const [rawPerRun, rawAllRuns] = raw;

    const perRun = Number(
        /US\$([\d.]+)/.exec(numberAfter(output, "per run  (evalBudget.maxUsd)"))?.[1]
    );
    const allRuns = Number(
        /US\$([\d.]+)/.exec(numberAfter(output, "all runs (programmeMaxMicroUsd)"))?.[1]
    );

    assert.ok(
        perRun >= rawPerRun,
        `the per-run ceiling US$${perRun} is below the worst case ${rawPerRun}`
    );
    assert.ok(
        allRuns >= rawAllRuns,
        `the programme ceiling US$${allRuns} is below the worst case ${rawAllRuns}`
    );

    // Up to the cent, not to some larger unit: a ceiling nobody can derive is
    // as unusable as one that is too low.
    assert.ok(perRun - rawPerRun < 0.01, `${perRun} is more than a cent above ${rawPerRun}`);
    assert.equal(Math.round(perRun * 100) / 100, perRun, "the per-run ceiling is not whole cents");
});

test("the programme total is the per-run ceiling times the runs, not a separate rounding", () => {
    // `findEvalRegisterProblems()` refuses a budget whose
    // `maxUsd × maxProviderDispatchedRuns` exceeds the programme figure.
    // Rounding the two ends independently is how a budget earns that refusal by
    // arithmetic nobody intended — US$6.50 per run against a US$12.99 programme
    // is exactly the shape.
    const output = run();
    // The label is the report's own; the section it cites is
    // docs/policy/external-conversation-import-and-memory.md §12.4, the
    // independent re-run.
    const runs = Number(numberAfter(output, "runs (§12.4 independent re-run)").trim());
    const perRun = Number(
        /US\$([\d.]+)/.exec(numberAfter(output, "per run  (evalBudget.maxUsd)"))?.[1]
    );
    const allRuns = Number(
        /US\$([\d.]+)/.exec(numberAfter(output, "all runs (programmeMaxMicroUsd)"))?.[1]
    );
    const micro = Number(
        /= (\d+) microUSD/.exec(numberAfter(output, "all runs (programmeMaxMicroUsd)"))?.[1]
    );

    assert.ok(Number.isInteger(runs) && runs > 0, output);
    assert.equal(allRuns, Number((perRun * runs).toFixed(2)));
    assert.equal(micro, Math.round(allRuns * 1_000_000));
    assert.ok(Number.isInteger(micro), "microUSD must be whole");
    // The register's own comparison, run here on the printed figures.
    assert.ok(
        Math.round(perRun * 1_000_000 * runs) <= micro,
        `${runs} runs at US$${perRun} exceeds the programme total ${micro} microUSD`
    );
});

test("the schema every request carries is counted as input", () => {
    // `memoryExtractionProvider` sends the output schema with
    // `strictJsonSchema`, so it is billed on every call. The estimate left it
    // out entirely, understating the input side by about 7% per case — which is
    // several times the rounding room the ceiling has.
    const output = run();
    const schemaTokens = Number(numberAfter(output, "  of which the JSON schema").trim());
    const meanTokens = Number(numberAfter(output, "mean input tokens per case").trim());
    assert.ok(schemaTokens > 0, `the schema is not counted:\n${output}`);
    assert.ok(
        meanTokens > schemaTokens,
        "the mean does not include the schema it reports"
    );
});

test("a fractional run count is refused rather than costed", () => {
    // `--runs=1.5` produced a report and a ceiling derived from one and a half
    // provider dispatches. `maxProviderDispatchedRuns` counts runs that either
    // happen or do not, so there was nothing to approve in that figure.
    for (const bad of ["--runs=1.5", "--runs=0", "--runs=-2", "--runs=two"]) {
        const result = invoke([bad]);
        assert.notEqual(result.status, 0, `${bad} produced a report:\n${result.stdout}`);
        assert.match(result.stderr, /--runs must be a positive integer/);
        assert.equal(result.stdout, "", `${bad} printed a costing before refusing`);
    }
    // And a whole one still works, so the guard is not refusing everything.
    assert.match(run(["--runs=3"]), /runs \(§12\.4 independent re-run\) *3/);
});

test("the report still says what it does not cover", () => {
    // The ceiling bounds this script's model of the worst case. It is not a
    // bound on what the provider bills — rounding on their side is outside it,
    // and so is any difference between this estimator and the provider's
    // tokenizer. Saying so is the honest half of handing over a number, and the
    // report used to claim the opposite: "a run that behaves cannot exceed it".
    const output = run();
    assert.match(output, /does not include/);
    assert.match(output, /provider-side rounding/);
    assert.match(output, /tokenizer/);
    assert.match(output, /NOT a quote/i);
    // The old claim may appear, but only in quotation marks as the thing this
    // report no longer says. A bare `doesNotMatch` caught the retraction itself,
    // which would have pushed the next author to delete the sentence that
    // explains the change rather than the claim.
    for (const line of output.split("\n").filter((l) => l.includes("cannot exceed it"))) {
        assert.match(line, /"[^"]*cannot exceed it/, `an unquoted claim: ${line}`);
    }
    assert.match(output, /the honest claim is narrower/);
    // The room it does have, stated as a number rather than implied.
    assert.match(output, /How much room the ceiling has over the worst case/);
    assert.match(output, /input tokens per case/);
});
