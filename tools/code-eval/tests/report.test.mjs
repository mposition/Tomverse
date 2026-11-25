import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { median, percent, renderComparison, renderSummary, summarizeRoute } from "../lib/report.mjs";
import { COMPARE, runNode, tempDir } from "./helpers.mjs";

const result = (route, taskId, category, passed, extra = {}) => ({ route, taskId, category, passed, adapterStatus: "ok", agentMs: 1000, totalMs: 1500, changedFiles: 2, ...extra });

const sample = [
    result("alpha", "bf-one", "bugfix", true, { agentMs: 1000, metrics: { costUsd: 0.25, inputTokens: 100, outputTokens: 10 } }),
    result("alpha", "ft-two", "feature", false, { agentMs: 3000, metrics: { costUsd: 0.5, inputTokens: 300, outputTokens: 30 }, adapterStatus: "timeout" }),
    result("alpha", "rf-three", "refactor", true, { agentMs: 2000 }),
    result("beta", "bf-one", "bugfix", false, { agentMs: 500, metrics: { credits: 3 } }),
    result("beta", "ft-two", "feature", true, { agentMs: 700, metrics: { credits: 4.5 } }),
    result("beta", "rf-three", "refactor", true, { agentMs: 900 }),
];

test("median and percent", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
    assert.equal(median([undefined, 5, NaN]), 5);
    assert.equal(percent(1, 3), "33.3%");
    assert.equal(percent(0, 0), "n/a");
});

test("summarizeRoute", () => {
    const alpha = summarizeRoute(sample, "alpha");
    assert.equal(alpha.total, 3);
    assert.equal(alpha.passed, 2);
    assert.equal(alpha.medianAgentMs, 2000);
    assert.equal(alpha.costUsd, 0.75);
    assert.equal(alpha.credits, null);
    assert.equal(alpha.inputTokens, 400);
    assert.equal(alpha.notOk, 1);
    assert.deepEqual(alpha.byCategory.bugfix, { total: 1, passed: 1 });
    assert.deepEqual(alpha.byCategory["test-writing"], { total: 0, passed: 0 });
    const beta = summarizeRoute(sample, "beta");
    assert.equal(beta.credits, 7.5);
    assert.equal(beta.costUsd, null);
});

test("renderSummary lays out route, category, cost and per-task tables", () => {
    const text = renderSummary({ results: sample, meta: { startedAt: "2026-01-01T00:00:00.000Z" } });
    assert.match(text, /^# Code eval summary/);
    assert.match(text, /\| alpha \| 2\/3 \| 66\.7% \| 1 \|/);
    assert.match(text, /\| beta \| 2\/3 \| 66\.7% \| 0 \|/);
    assert.match(text, /\| bugfix \| 1\/1 \(100\.0%\) \| 0\/1 \(0\.0%\) \|/);
    assert.match(text, /\| alpha \| 2\.0 \| 1\.5 \| 2 \| 0\.75 \| n\/a \| 400 \| 40 \|/);
    assert.match(text, /\| beta \| 0\.7 \| 1\.5 \| 2 \| n\/a \| 7\.5 \| n\/a \| n\/a \|/);
    assert.match(text, /\| ft-two \| feature \| FAIL \(timeout\) \| PASS \|/);
    assert.match(text, /\| test-writing \| 0\/0 \(n\/a\) \| 0\/0 \(n\/a\) \|/);
});

test("renderComparison lists fixed and regressed tasks against the baseline", () => {
    const before = { label: "before", results: sample.filter((r) => r.route === "alpha") };
    const after = {
        label: "after",
        results: [
            result("alpha", "bf-one", "bugfix", false),
            result("alpha", "ft-two", "feature", true),
            result("alpha", "rf-three", "refactor", true),
            result("alpha", "new-task", "bugfix", true),
        ],
    };
    const text = renderComparison([before, after]);
    assert.match(text, /^# Code eval comparison/);
    assert.match(text, /Baseline: before/);
    assert.match(text, /\| before \| 2\/3 \| 66\.7% \| - \|/);
    assert.match(text, /\| after \| 3\/4 \| 75\.0% \| 8\.3 pt \|/);
    assert.match(text, /- fixed \(fail to pass\): ft-two/);
    assert.match(text, /- regressed \(pass to fail\): bf-one/);
    assert.match(text, /- only in this run: new-task/);
    assert.ok(!renderComparison([before, after], { route: "beta" }).includes("## Route alpha"));
});

test("compare.mjs reads run folders and results.json files", () => {
    const sandbox = tempDir();
    try {
        const write = (name, results) => {
            mkdirSync(join(sandbox.dir, name));
            writeFileSync(join(sandbox.dir, name, "results.json"), JSON.stringify({ results }));
            return join(sandbox.dir, name);
        };
        const a = write("run-a", sample.filter((r) => r.route === "alpha"));
        const b = write("run-b", sample.filter((r) => r.route === "alpha").map((r) => ({ ...r, passed: true })));
        const run = runNode([COMPARE, a, join(b, "results.json")]);
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /Baseline: run-a/);
        assert.match(run.stdout, /\| run-b \| 3\/3 \| 100\.0% \| 33\.3 pt \|/);
        assert.match(run.stdout, /- fixed \(fail to pass\): ft-two/);
        const out = join(sandbox.dir, "compare.md");
        assert.equal(runNode([COMPARE, a, b, "--out", out]).status, 0);
        assert.match(readFileSync(out, "utf8"), /# Code eval comparison/);
        assert.equal(runNode([COMPARE, a]).status, 2);
        assert.equal(runNode([COMPARE, a, join(sandbox.dir, "missing")]).status, 2);
    } finally {
        sandbox.dispose();
    }
});
