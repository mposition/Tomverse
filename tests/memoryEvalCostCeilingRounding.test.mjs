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

const run = () =>
    spawnSync(
        process.execPath,
        [
            "--conditions=react-server",
            "--import",
            "tsx",
            "scripts/report-memory-eval-cost-estimate.mjs",
        ],
        { cwd: new URL("..", import.meta.url), encoding: "utf8" }
    ).stdout;

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

test("the report still says what it does not cover", () => {
    // The ceiling bounds this model of the worst case. It is not a bound on
    // what the provider bills: rounding on their side is outside it and the
    // report says so, which is the honest half of handing over a number.
    const output = run();
    assert.match(output, /does not include/);
    assert.match(output, /provider-side rounding/);
    assert.match(output, /NOT a quote/i);
});
