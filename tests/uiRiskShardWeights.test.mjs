import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// PR Fast Gate's ui-risk job lists its shards per project (see the comment on
// the job in .github/workflows/pr-fast-gate.yml) and balances them with
// PWTEST_SHARD_WEIGHTS from each matrix entry. Two mistakes would slip past a
// green run. Playwright throws when the weight count differs from the shard
// total, which fails every shard of that project on every pull request. And a
// listed matrix that drops an entry, or leaves `shards` at an old total, runs
// the tests past the last listed shard nowhere while every job that did run
// passes. These checks catch both before CI does.

const workflow = parse(
    readFileSync(new URL("../.github/workflows/pr-fast-gate.yml", import.meta.url), "utf8")
);
const job = workflow.jobs["ui-risk"];
const entries = job.strategy.matrix.include;
const runStep = job.steps.find((step) => String(step.run ?? "").includes("test:e2e:ui-risk:shard"));
const shardScript = readFileSync(new URL("../scripts/run-ui-risk-shard.mjs", import.meta.url), "utf8");

test("the matrix is a plain include list, not a crossed product", () => {
    assert.ok(Array.isArray(entries) && entries.length > 0, "matrix.include lists the shards");
    assert.deepEqual(Object.keys(job.strategy.matrix), ["include"]);
    for (const entry of entries) {
        assert.deepEqual(Object.keys(entry).sort(), ["project", "shard", "shards", "weights"], JSON.stringify(entry));
    }
});

test("every project the shard script accepts is in the matrix, and nothing else", () => {
    const accepted = JSON.parse(shardScript.match(/const PROJECTS = (\[[^\]]*\]);/)[1]);
    const listed = [...new Set(entries.map((entry) => entry.project))];
    assert.deepEqual(listed.sort(), [...accepted].sort());
});

test("each project's shards are exactly 1..N with one positive weight per shard", () => {
    const byProject = Map.groupBy(entries, (entry) => entry.project);
    for (const [project, shards] of byProject) {
        const totals = new Set(shards.map((entry) => entry.shards));
        assert.equal(totals.size, 1, `${project} names one shard total`);
        const [total] = totals;
        assert.ok(Number.isInteger(total) && total >= 1, `${project} total is a positive integer`);
        assert.deepEqual(
            shards.map((entry) => entry.shard).sort((a, b) => a - b),
            Array.from({ length: total }, (_, i) => i + 1),
            `${project} lists every shard of ${total} exactly once`
        );

        const weightSets = new Set(shards.map((entry) => entry.weights));
        assert.equal(weightSets.size, 1, `${project} uses one weight list for all its shards`);
        const weights = String([...weightSets][0]).split(":");
        assert.equal(weights.length, total, `${project} names one weight per shard`);
        // Playwright parses each with parseInt and rejects negatives; a zero
        // would leave a shard with nothing to run.
        for (const weight of weights) assert.match(weight, /^[1-9][0-9]*$/, `${project}: ${weight}`);
    }
});

test("the run step forwards the entry's project, shard and weights", () => {
    assert.ok(runStep, "the ui-risk run step exists");
    assert.equal(runStep.env?.UI_RISK_PROJECT, "${{ matrix.project }}");
    assert.equal(runStep.env?.PWTEST_SHARD_WEIGHTS, "${{ matrix.weights }}");
    assert.match(String(runStep.run), /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}/);
});
